/* ================================================================
   TreeTab — New Tab Dashboard
   Top: Domain-grouped tabs (kanban cards)
   Bottom: Browser tab groups (masonry layout, drag to manage)

   Features:
   1. Display browser tab groups with drag-and-drop management
   2. Group tabs by domain
   3. Landing page detection
   4. Duplicate tab detection
   5. Close animation (sound + confetti)
   6. Live board — Chrome tab/group events schedule a debounced refresh
   ================================================================ */

'use strict';

// ================================================================
// Constants
// ================================================================

const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan'];

/** Sentinel domain key of the aggregated homepages card */
const LANDING_DOMAIN = '__landing-pages__';

/** Domain cards show this many page chips before folding the rest into "+N more" */
const CHIP_LIMIT = 8;

/** Chrome fires bursts of tab events; coalesce them into a single render */
const REFRESH_DEBOUNCE_MS = 300;

/** How long a bulk-close button stays armed waiting for its second click */
const CONFIRM_TIMEOUT_MS = 3000;

/** Shown when a tab reports no favicon — keeps the page free of third-party requests */
const FALLBACK_FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='6.25' fill='none' stroke='%237db9a8' stroke-width='1.5' opacity='0.55'/%3E%3Ccircle cx='8' cy='8' r='2.25' fill='%237db9a8' opacity='0.45'/%3E%3C/svg%3E";

/** Card headings that prettifying would only make worse */
const FRIENDLY_DOMAINS = {
  'github.com': 'GitHub',
  'www.github.com': 'GitHub',
  'youtube.com': 'YouTube',
  'www.youtube.com': 'YouTube',
  'x.com': 'X',
  'twitter.com': 'X',
  'reddit.com': 'Reddit',
  'www.reddit.com': 'Reddit',
  'linkedin.com': 'LinkedIn',
  'www.linkedin.com': 'LinkedIn',
  'mail.google.com': 'Gmail',
  'local-files': 'Local Files',
};

/** Homepage-ish URLs, pulled out of their domain card into a shared one */
const LANDING_PAGE_PATTERNS = [
  { hostname: 'mail.google.com', test: (p, h) => !h.includes('#inbox/') && !h.includes('#sent/') },
  { hostname: 'x.com', pathExact: ['/home'] },
  { hostname: 'www.linkedin.com', pathExact: ['/'] },
  { hostname: 'github.com', pathExact: ['/'] },
  { hostname: 'www.youtube.com', pathExact: ['/'] },
  { hostname: 'ehall.cdu.edu.cn', test: (p, h) => h.includes('act=fp/formHome') },
  { hostname: 'www.bilibili.com', pathExact: ['/'] },
  { hostname: 'gitcode.com', pathExact: ['/'] },
];

/** ehall.cdu.edu.cn act= values worth naming by hand */
const SPECIAL_NAMES = {
  'fp/formHome': '首页',
  'fp/svsmng': '服务配置管理',
  'fp/printing': '打印模板管理',
};

/** English → Chinese vocabulary used to humanize camelCase act names */
const VOCAB = {
  'form': '表单',
  'process': '流程',
  'mng': '管理',
  'design': '设计',
  'home': '首页',
  'business': '业务',
  'report': '报表',
  'printing': '打印',
  'view': '查看',
  'edit': '编辑',
  'create': '创建',
  'list': '列表',
  'detail': '详情',
  'search': '搜索',
  'query': '查询',
  'config': '配置',
  'setting': '设置',
  'user': '用户',
  'admin': '管理',
  'svs': '服务',
};

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// ================================================================
// Global state
// ================================================================

let allTabs = [];
let allGroups = [];
let domainGroups = [];
let draggedTabId = null;

/** Window this page lives in — lets us ignore focus events from other windows */
let pageWindowId = null;

/** Cards the user unfolded past CHIP_LIMIT, keyed by domain / 'ungrouped' */
const expandedCards = new Set();

/** Card scroll offsets, captured before a re-render and restored after */
const cardScrollPositions = new Map();

let refreshTimer = null;
let refreshQueued = false;
let toastTimer = null;
let confirmTimer = null;
let audioContext = null;

// ================================================================
// Small helpers
// ================================================================

/**
 * escapeHtml(value)
 * * Escape for interpolation into innerHTML. Tab and group titles are
 *   page-controlled, so a title containing "<" or a quote must not be able
 *   to break a card's markup.
 */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ESCAPE_MAP[ch]);
}

/**
 * faviconFor(tab)
 * * Icons come from the tab itself: no favicon service request, so the page
 *   stays local and icons render offline.
 */
function faviconFor(tab) {
  return tab.favIconUrl || FALLBACK_FAVICON;
}

/**
 * visibleTabsOf(uniqueTabs, key)
 * * Respect a card's expanded/collapsed state and report what was folded away.
 */
function visibleTabsOf(uniqueTabs, key) {
  return expandedCards.has(key) ? uniqueTabs : uniqueTabs.slice(0, CHIP_LIMIT);
}

// ================================================================
// Data fetching
// ================================================================

async function fetchData() {
  try {
    const currentWindow = await chrome.windows.getCurrent();
    pageWindowId = currentWindow.id;

    const [tabs, groups] = await Promise.all([
      chrome.tabs.query({ currentWindow: true }),
      chrome.tabGroups.query({ windowId: currentWindow.id })
    ]);

    // Filter out internal pages
    allTabs = tabs.filter(tab => {
      const url = tab.url || '';
      if (url === 'chrome://newtab/') return false;
      return (
        !url.startsWith('chrome://') &&
        !url.startsWith('chrome-extension://') &&
        !url.startsWith('about:') &&
        !url.startsWith('edge://') &&
        !url.startsWith('brave://') &&
        !url.startsWith('devtools://')
      );
    });

    allGroups = groups;

    // Update stats
    const tabCount = allTabs.length;
    document.getElementById('statTabs').textContent = tabCount;
    updateTabCountBadge(tabCount);

    return { tabs: allTabs, groups: allGroups };
  } catch (err) {
    console.error('[TreeTab] Failed to fetch data:', err);
    showToast('Failed to fetch data');
    return { tabs: [], groups: [] };
  }
}

// ================================================================
// Tab Groups rendering (top section)
// ================================================================

function renderGroups() {
  const container = document.getElementById('groupsContainer');
  const countEl = document.getElementById('groupsCount');
  const section = document.getElementById('groupsSection');

  if (!container) return;
  container.innerHTML = '';

  // Count groups with tabs
  const groupTabsMap = {};
  for (const tab of allTabs) {
    if (tab.groupId && tab.groupId !== -1) {
      if (!groupTabsMap[tab.groupId]) groupTabsMap[tab.groupId] = [];
      groupTabsMap[tab.groupId].push(tab);
    }
  }

  const activeGroups = allGroups.filter(g => groupTabsMap[g.id]?.length > 0);
  if (countEl) countEl.textContent = `${activeGroups.length} groups`;

  // With no real groups this section would only repeat the domain board above
  if (activeGroups.length === 0) {
    if (section) section.style.display = 'none';
    return;
  }
  if (section) section.style.display = 'block';

  // Render each group
  for (const group of activeGroups) {
    const groupCard = createGroupCard(group, groupTabsMap[group.id]);
    container.appendChild(groupCard);
  }

  // Always rendered once groups exist: it is the only drop target for dragging
  // a tab back out of a group.
  const ungroupedTabs = allTabs.filter(t => !t.groupId || t.groupId === -1);
  container.appendChild(createUngroupedCard(ungroupedTabs));
}

function createGroupCard(group, tabs) {
  const card = document.createElement('div');
  card.className = 'group-card';
  card.dataset.groupId = group.id;

  const header = document.createElement('div');
  header.className = 'group-header';
  header.innerHTML = `
    <div class="group-color group-color-${group.color}"></div>
    <div class="group-title" data-group-id="${group.id}">${escapeHtml(group.title || 'Unnamed Group')}</div>
    <div class="group-actions">
      <button class="group-action-btn group-edit-btn" data-action="edit-group-name" data-group-id="${group.id}" title="Rename" aria-label="Rename group">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Zm0 0L19.5 7.125" />
        </svg>
      </button>
      <button class="group-action-btn group-close-btn" data-action="delete-group" data-group-id="${group.id}" title="Delete group" aria-label="Delete group">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
    <div class="group-count">${tabs.length}</div>
  `;

  // Click group name to edit
  const titleEl = header.querySelector('.group-title');
  titleEl.addEventListener('click', () => {
    editGroupName(group.id, titleEl);
  });

  const tabsList = document.createElement('div');
  tabsList.className = 'group-tabs-list';

  for (const tab of tabs) {
    const tabEl = createGroupTabElement(tab);
    tabsList.appendChild(tabEl);
  }

  card.appendChild(header);
  card.appendChild(tabsList);

  // Drop a tab here to move it into this group
  setupDropZone(card, tabId => {
    const tab = allTabs.find(t => t.id === tabId);
    if (!tab || tab.groupId === group.id) return;
    return runTabAction(
      () => chrome.tabs.group({ groupId: group.id, tabIds: [tabId] }),
      'Moved to group'
    );
  });

  return card;
}

function createUngroupedCard(tabs) {
  const card = document.createElement('div');
  card.className = 'group-card';
  card.dataset.groupId = 'ungrouped';

  const header = document.createElement('div');
  header.className = 'group-header';
  header.innerHTML = `
    <div class="group-color group-color-ungrouped"></div>
    <div class="group-title">Ungrouped</div>
    <div class="group-count">${tabs.length}</div>
  `;

  const tabsList = document.createElement('div');
  tabsList.className = 'group-tabs-list';

  if (tabs.length === 0) {
    tabsList.innerHTML = '<div class="group-empty-hint">Drop a tab here to ungroup it</div>';
  } else {
    const visible = visibleTabsOf(tabs, 'ungrouped');
    for (const tab of visible) {
      tabsList.appendChild(createGroupTabElement(tab));
    }
    if (tabs.length > visible.length) {
      tabsList.appendChild(createOverflowChip('ungrouped', `+${tabs.length - visible.length} more`));
    } else if (visible.length > CHIP_LIMIT) {
      tabsList.appendChild(createOverflowChip('ungrouped', 'Show less', 'collapse-chips'));
    }
  }

  card.appendChild(header);
  card.appendChild(tabsList);

  // Drop here to ungroup
  setupDropZone(card, tabId => {
    const tab = allTabs.find(t => t.id === tabId);
    if (!tab || !tab.groupId || tab.groupId === -1) return;
    return runTabAction(() => chrome.tabs.ungroup(tabId), 'Removed from group');
  });

  return card;
}

/**
 * createOverflowChip(key, label, action)
 * * The "+N more" / "Show less" row that folds long card lists.
 */
function createOverflowChip(key, label, action = 'expand-chips') {
  const el = document.createElement('div');
  el.className = 'page-chip page-chip-overflow';
  el.dataset.action = action;
  el.dataset.cardKey = key;
  el.textContent = label;
  return el;
}

function createGroupTabElement(tab) {
  const el = document.createElement('div');
  el.className = 'group-tab-item';
  el.draggable = true;
  el.dataset.tabId = tab.id;

  const rawTitle = stripTitleSuffix(tab.title || tab.url || 'Untitled');
  const title = getCustomTitle(rawTitle, tab.url);

  el.innerHTML = `
    <img class="group-tab-favicon" src="${escapeHtml(faviconFor(tab))}" alt="">
    <div class="group-tab-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
    <div class="group-tab-actions">
      <button class="group-tab-action group-tab-close" data-tab-id="${tab.id}" title="Close tab" aria-label="Close tab">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  `;

  // Click to switch to tab
  el.addEventListener('click', (e) => {
    if (e.target.closest('.group-tab-action')) return;
    focusTab(tab.id);
  });

  // Close button — fully close tab
  const closeBtn = el.querySelector('.group-tab-close');
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(tab.id, el);
  });

  // Drag events
  el.addEventListener('dragstart', handleDragStart);
  el.addEventListener('dragend', handleDragEnd);

  return el;
}

// ================================================================
// Drag logic
// ================================================================

/**
 * handleDragStart(e)
 * * Both card systems (domain chips and group tab rows) share one drag
 *   handler: the dragged tab id is the only thing a drop zone needs.
 */
function handleDragStart(e) {
  const item = e.target.closest('.group-tab-item, .page-chip');
  if (!item) return;

  const tabId = parseInt(item.dataset.tabId, 10);
  if (!tabId || isNaN(tabId)) return;

  draggedTabId = tabId;
  item.classList.add('dragging');

  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(tabId));

  // Nudge first-time users: chips can be dropped onto a group
  if (item.classList.contains('page-chip')) {
    showToast('Drop onto a group or the new group zone');
  }
}

function handleDragEnd(e) {
  const item = e.target.closest('.group-tab-item, .page-chip');
  if (item) item.classList.remove('dragging');

  clearDragOver();
  draggedTabId = null;
}

function clearDragOver() {
  document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
}

/**
 * setupDropZone(element, onDrop)
 * * One drop-target implementation for every zone (group cards, the ungrouped
 *   card, the new-group strip). onDrop gets the dragged tab id; foreign drags
 *   (files, selected text) are ignored.
 */
function setupDropZone(element, onDrop) {
  element.addEventListener('dragover', (e) => {
    if (draggedTabId === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    element.classList.add('drag-over');
  });

  element.addEventListener('dragleave', (e) => {
    if (!element.contains(e.relatedTarget)) {
      element.classList.remove('drag-over');
    }
  });

  element.addEventListener('drop', async (e) => {
    e.preventDefault();
    element.classList.remove('drag-over');

    // draggedTabId stays set until dragend, which fires after drop
    const tabId = draggedTabId ?? parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (!tabId || isNaN(tabId)) return;

    await onDrop(tabId);
  });
}

/**
 * setupNewGroupDropzone()
 * * Dropping a tab on the strip between the two sections starts a new group.
 */
function setupNewGroupDropzone() {
  const dropzone = document.getElementById('newGroupDropzone');
  if (!dropzone) return;

  setupDropZone(dropzone, tabId => runTabAction(async () => {
    const color = GROUP_COLORS[Math.floor(Math.random() * GROUP_COLORS.length)];
    const newGroupId = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(newGroupId, { color, title: 'New Group' });
  }, 'New group created'));
}

// ================================================================
// Tab group operations
// ================================================================

/**
 * editGroupName(groupId, titleEl)
 * * Edit a tab group name in place.
 */
async function editGroupName(groupId, titleEl) {
  const currentTitle = titleEl.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentTitle;
  input.className = 'group-title-input';
  input.setAttribute('aria-label', 'Group name');

  // Replace title with input
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  // Enter and blur can both fire for the same edit — save exactly once
  let settled = false;

  const save = async () => {
    if (settled) return;
    settled = true;

    const newTitle = input.value.trim();
    if (!newTitle || newTitle === currentTitle) {
      input.replaceWith(titleEl);
      flushRefresh();
      return;
    }

    try {
      await chrome.tabGroups.update(groupId, { title: newTitle });
      showToast('Group renamed');
      await refreshAll();
    } catch (err) {
      console.error('[TreeTab] Rename failed:', err);
      showToast('Rename failed');
      input.replaceWith(titleEl);
    }
  };

  // Enter to save, ESC to cancel
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      settled = true;
      input.replaceWith(titleEl);
    }
  });

  // Save on blur
  input.addEventListener('blur', save);
}

/**
 * removeTabs(tabIds)
 * * Close tabs, tolerating ids that vanished between render and click —
 *   chrome.tabs.remove() rejects the whole batch if a single id is stale.
 */
async function removeTabs(tabIds) {
  if (tabIds.length === 0) return;

  try {
    await chrome.tabs.remove(tabIds);
  } catch {
    for (const id of tabIds) {
      try {
        await chrome.tabs.remove(id);
      } catch {
        // already closed elsewhere
      }
    }
  }
}

/**
 * deleteGroup(groupId)
 * * Delete a tab group and close all its tabs. Closing the last tab removes
 *   the group itself: chrome.tabGroups exposes no remove() method.
 */
async function deleteGroup(groupId) {
  const groupTabs = allTabs.filter(t => t.groupId === groupId);
  if (groupTabs.length === 0) return;

  playCloseSound();
  await runTabAction(
    () => removeTabs(groupTabs.map(t => t.id)),
    'Group and tabs closed'
  );
}

// ================================================================
// Domain grouping rendering (bottom) — original feature
// ================================================================

/**
 * isLandingPage(url)
 * * True for the "just opened the site" URLs that share the Homepages card.
 */
function isLandingPage(url) {
  try {
    const parsed = new URL(url);
    return LANDING_PAGE_PATTERNS.some(p => {
      const hostnameMatch = parsed.hostname === p.hostname;
      if (!hostnameMatch) return false;
      if (p.test) return p.test(parsed.pathname, url);
      if (p.pathExact) return p.pathExact.includes(parsed.pathname);
      return parsed.pathname === '/';
    });
  } catch { return false; }
}

function organizeByDomain(tabs) {
  const groupMap = {};
  const landingTabs = [];

  for (const tab of tabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      const hostname = tab.url?.startsWith('file://')
        ? 'local-files'
        : new URL(tab.url).hostname;

      if (!hostname) continue;

      if (!groupMap[hostname]) {
        groupMap[hostname] = { domain: hostname, tabs: [] };
      }
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip invalid URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap[LANDING_DOMAIN] = { domain: LANDING_DOMAIN, tabs: landingTabs };
  }

  // Sort: landing pages first, then by tab count
  return Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === LANDING_DOMAIN;
    const bIsLanding = b.domain === LANDING_DOMAIN;
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;
    return b.tabs.length - a.tabs.length;
  });
}

function friendlyDomain(hostname) {
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app)$/, '');

  return clean.split('.').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

function stripTitleSuffix(title) {
  if (!title) return '';
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

/**
 * getCustomTitle(title, url)
 * * Extract meaningful titles for specific domains
 */
function getCustomTitle(title, url) {
  if (!url) return title;

  try {
    const parsed = new URL(url);

    // CDU ehall system
    if (parsed.hostname === 'ehall.cdu.edu.cn') {
      const hash = parsed.hash || '';
      const actMatch = hash.match(/act=([^&]+)/);

      if (actMatch) {
        const act = actMatch[1]; // e.g. fp/svsmng/processMng or fp/printing

        // Try to get friendly name from mapping
        let actName = SPECIAL_NAMES[act];

        // Fall back to extracting last path segment
        if (!actName) {
          // Extract last path segment, e.g. fp/svsmng/processMng -> processMng
          const parts = act.split('/');
          const lastPart = parts[parts.length - 1];

          // Format camelCase to Chinese
          actName = formatCamelCase(lastPart);
        }

        // Extract ID if present
        const idMatch = hash.match(/(?:formId|selectedID|id)=([a-z0-9\-]+)/i);
        if (idMatch) {
          const shortId = idMatch[1].substring(0, 8);
          return `智慧教育 · ${actName} · ${shortId}`;
        }

        return `智慧教育 · ${actName}`;
      }

      return '智慧教育';
    }
  } catch {
    // Return original title on parse failure
  }

  return title;
}

/**
 * formatCamelCase(str)
 * * Convert camelCase to Chinese-friendly format
 * * e.g. processMng -> 流程管理, formDesign -> 表单设计
 */
function formatCamelCase(str) {
  if (!str) return '';

  // Try direct word match (case-insensitive)
  const lowerStr = str.toLowerCase();
  for (const [en, cn] of Object.entries(VOCAB)) {
    if (lowerStr === en.toLowerCase()) {
      return cn;
    }
  }

  // Try splitting camelCase
  // e.g. processMng -> ['process', 'Mng'] -> 流程管理
  const words = str.split(/(?=[A-Z])/);
  const translated = words.map(word => {
    const lower = word.toLowerCase();
    return VOCAB[lower] || word;
  });

  return translated.join('');
}

function renderDomains() {
  const container = document.getElementById('domainsMissions');
  const countEl = document.getElementById('domainsCount');
  const section = document.getElementById('domainsSection');
  const dropzone = document.getElementById('newGroupDropzone');

  if (!container) return;
  container.innerHTML = '';

  domainGroups = organizeByDomain(allTabs);

  // Nothing else open: a friendly panel beats an empty grid
  if (allTabs.length === 0) {
    if (section) section.style.display = 'block';
    if (countEl) countEl.textContent = '';
    if (dropzone) dropzone.style.display = 'none';
    container.innerHTML = renderEmptyState();
    return;
  }

  if (section) section.style.display = 'block';
  if (dropzone) dropzone.style.display = '';
  if (countEl) countEl.textContent = `${domainGroups.length} domains`;

  for (const group of domainGroups) {
    const card = createDomainCard(group);
    container.appendChild(card);
  }

  // Chips are rebuilt on every render, so re-attach their drag handlers
  container.querySelectorAll('.page-chip[draggable="true"]').forEach(chip => {
    chip.addEventListener('dragstart', handleDragStart);
    chip.addEventListener('dragend', handleDragEnd);
  });
}

/**
 * renderEmptyState()
 * * Markup for the "nothing else open" panel (styles: .missions-empty-state).
 */
function renderEmptyState() {
  return `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">All clear</div>
      <div class="empty-subtitle">Nothing else open in this window.</div>
    </div>`;
}

function createDomainCard(group) {
  const tabs = group.tabs;
  const isLanding = group.domain === LANDING_DOMAIN;

  // Pinned tabs are listed, but no bulk action ever closes them
  const closableTabs = tabs.filter(t => !t.pinned);

  const urlCounts = {};
  for (const tab of closableTabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;

  const dupeUrls = Object.entries(urlCounts).filter(([, count]) => count > 1);
  const totalExtras = dupeUrls.reduce((sum, [, count]) => sum + count - 1, 0);
  const hasDupes = totalExtras > 0;

  const card = document.createElement('div');
  card.className = `mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}`;

  // Badges
  let badgesHtml = `<span class="open-tabs-badge">
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" style="width:10px;height:10px">
      <path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" />
    </svg>
    ${tabs.length} tabs
  </span>`;

  if (hasDupes) {
    badgesHtml += `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">${totalExtras} duplicates</span>`;
  }

  // Tab chips — one per URL, duplicates collapse into a "(2x)" tag
  const seen = new Set();
  const uniqueTabs = tabs.filter(t => {
    if (seen.has(t.url)) return false;
    seen.add(t.url);
    return true;
  });

  const visibleTabs = visibleTabsOf(uniqueTabs, group.domain);
  const hiddenCount = uniqueTabs.length - visibleTabs.length;

  let chipsHtml = visibleTabs.map(tab => {
    const rawTitle = stripTitleSuffix(tab.title || tab.url);
    const label = getCustomTitle(rawTitle, tab.url);
    const count = urlCounts[tab.url];
    const dupeTag = count > 1 ? `<span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? 'chip-has-dupes' : '';
    const pin = tab.pinned ? `<svg class="chip-pin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 3.75h7.5m-5.25 0v5.25L8.25 11.25v1.5h7.5v-1.5L13.5 9V3.75M12 12.75v7.5" /></svg>` : '';

    return `<div class="page-chip clickable ${chipClass}"
      draggable="true"
      data-tab-id="${tab.id}"
      data-action="focus-tab"
      role="button"
      tabindex="0"
      title="${escapeHtml(label)}">
      ${pin}<img class="chip-favicon" src="${escapeHtml(faviconFor(tab))}" alt="">
      <span class="chip-text">${escapeHtml(label)}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-id="${tab.id}" title="Close tab" aria-label="Close tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  if (hiddenCount > 0) {
    chipsHtml += `<div class="page-chip page-chip-overflow" data-action="expand-chips" data-card-key="${escapeHtml(group.domain)}" role="button" tabindex="0">+${hiddenCount} more</div>`;
  } else if (visibleTabs.length > CHIP_LIMIT) {
    chipsHtml += `<div class="page-chip page-chip-overflow" data-action="collapse-chips" data-card-key="${escapeHtml(group.domain)}" role="button" tabindex="0">Show less</div>`;
  }

  // Action buttons
  let actionsHtml = '';

  if (closableTabs.length > 0) {
    const pinnedNote = closableTabs.length < tabs.length
      ? 'Pinned tabs are kept open'
      : 'Close every tab in this card';
    actionsHtml += `<button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain="${escapeHtml(group.domain)}" title="${pinnedNote}">Close all ${closableTabs.length} tabs</button>`;
  }

  if (hasDupes) {
    actionsHtml += `<button class="action-btn" data-action="dedup-keep-one" data-domain="${escapeHtml(group.domain)}">Close ${totalExtras} duplicates</button>`;
  }

  card.innerHTML = `
    <div class="mission-content">
      <div class="mission-top">
        <span class="mission-name">${escapeHtml(isLanding ? 'Homepages' : friendlyDomain(group.domain))}</span>
        ${badgesHtml}
      </div>
      <div class="mission-pages">${chipsHtml}</div>
      <div class="actions">${actionsHtml}</div>
    </div>
  `;

  return card;
}

// ================================================================
// Close animation (sound + confetti)
// ================================================================

/**
 * ensureAudioContext()
 * * One shared AudioContext: creating and tearing down one per close hits the
 *   browser's context limit as soon as tabs are closed in bulk.
 */
function ensureAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }

  if (audioContext.state === 'suspended') {
    audioContext.resume().catch(() => {});
  }

  return audioContext;
}

function playCloseSound() {
  try {
    const ctx = ensureAudioContext();
    const t = ctx.currentTime;
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * duration), ctx.sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);
  } catch {
    // Audio is decorative — it must never break a close
  }
}

function shootConfetti(x, y) {
  const colors = ['#c8713a', '#5a7a62', '#5a6b7a', '#b35a5a', '#d4b896'];
  const particleCount = 12;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');
    const size = 5 + Math.random() * 6;
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${Math.random() > 0.5 ? '50%' : '2px'};
      pointer-events: none;
      z-index: 200; /* --z-confetti */
      transform: translate(-50%, -50%);
    `;
    document.body.appendChild(el);

    const angle = Math.random() * Math.PI * 2;
    const speed = 60 + Math.random() * 100;
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed - 60;
    const gravity = 200;

    const startTime = performance.now();
    const duration = 600 + Math.random() * 200;

    function frame(now) {
      const elapsed = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) { el.remove(); return; }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px))`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * closeTab(tabId, element)
 * * Play the close animation, then actually close the tab and repaint — the
 *   repaint happens even when the tab was already closed elsewhere, so a
 *   stale card never survives on screen.
 */
async function closeTab(tabId, element) {
  if (element) {
    element.style.transition = 'opacity 0.2s, transform 0.2s';
    element.style.opacity = '0';
    element.style.transform = 'scale(0.9)';

    // Confetti effect
    const rect = element.getBoundingClientRect();
    shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  playCloseSound();
  await new Promise(r => setTimeout(r, 200));

  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // Already closed by another page or window
  }

  await refreshAll();
}

// ================================================================
// Event handling
// ================================================================

document.addEventListener('click', async (e) => {
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  // Fold / unfold a long card list
  if (action === 'expand-chips' || action === 'collapse-chips') {
    const key = actionEl.dataset.cardKey;
    if (action === 'expand-chips') expandedCards.add(key);
    else expandedCards.delete(key);
    renderDomains();
    renderGroups();
    return;
  }

  // Close duplicate TreeTab tabs
  if (action === 'close-tabout-dupes') {
    const newtabUrl = `chrome-extension://${chrome.runtime.id}/index.html`;
    const openTabs = await chrome.tabs.query({});
    const newtabTabs = openTabs.filter(t =>
      t.url === newtabUrl || t.url === 'chrome://newtab/'
    );

    if (newtabTabs.length > 1) {
      const keep = newtabTabs.find(t => t.active && t.windowId === pageWindowId) ||
                   newtabTabs.find(t => t.active) ||
                   newtabTabs[0];
      const toClose = newtabTabs.filter(t => t.id !== keep.id).map(t => t.id);

      if (toClose.length > 0) {
        playCloseSound();
        await removeTabs(toClose);
        showToast('Closed extra TreeTab tabs');
        await refreshAll();
      }
    }
    return;
  }

  // Switch to tab
  if (action === 'focus-tab') {
    await focusTab(parseInt(actionEl.dataset.tabId, 10));
    return;
  }

  // Close single tab
  if (action === 'close-single-tab') {
    const tabId = parseInt(actionEl.dataset.tabId, 10);
    if (!tabId || isNaN(tabId)) return;
    await closeTab(tabId, actionEl.closest('.page-chip') || actionEl.closest('.group-tab-item'));
    return;
  }

  // Edit group name
  if (action === 'edit-group-name') {
    const groupId = parseInt(actionEl.dataset.groupId, 10);
    const titleEl = actionEl.closest('.group-header').querySelector('.group-title');
    if (groupId && titleEl) {
      editGroupName(groupId, titleEl);
    }
    return;
  }

  // Delete group (both group and tabs)
  if (action === 'delete-group') {
    const groupId = parseInt(actionEl.dataset.groupId, 10);
    if (groupId) {
      const group = allGroups.find(g => g.id === groupId);
      const groupTabs = allTabs.filter(t => t.groupId === groupId);
      if (confirm(`Delete group "${group?.title || 'Untitled'}"?\n\n${groupTabs.length} tabs will be closed and the group will be removed.`)) {
        await deleteGroup(groupId);
      }
    }
    return;
  }

  // Close every closable tab in one domain card — bulk, so it asks twice
  if (action === 'close-domain-tabs') {
    const group = domainGroups.find(g => g.domain === actionEl.dataset.domain);
    if (!group) return;

    const tabIds = group.tabs.filter(t => !t.pinned).map(t => t.id);
    if (tabIds.length === 0) return;

    if (needsConfirm(actionEl, `Confirm: close ${tabIds.length} tabs`)) return;

    playCloseSound();
    const card = actionEl.closest('.mission-card');
    if (card) {
      const rect = card.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      card.classList.add('closing');
      // Let the fade-out play before the re-render wipes the card
      await new Promise(r => setTimeout(r, 220));
    }

    await removeTabs(tabIds);
    await refreshAll();
    showToast(`Closed ${tabIds.length} tabs`);
    return;
  }

  // Deduplication — one survivor per URL, scoped to what the card shows
  if (action === 'dedup-keep-one') {
    const group = domainGroups.find(g => g.domain === actionEl.dataset.domain);
    if (!group) return;

    const byUrl = new Map();
    for (const tab of group.tabs) {
      if (tab.pinned) continue;
      if (!byUrl.has(tab.url)) byUrl.set(tab.url, []);
      byUrl.get(tab.url).push(tab);
    }

    const tabIds = [];
    for (const tabs of byUrl.values()) {
      if (tabs.length < 2) continue;
      const keep = tabs.find(t => t.active) || tabs[0];
      for (const tab of tabs) {
        if (tab.id !== keep.id) tabIds.push(tab.id);
      }
    }
    if (tabIds.length === 0) return;

    if (needsConfirm(actionEl, `Confirm: close ${tabIds.length} duplicates`)) return;

    playCloseSound();
    await removeTabs(tabIds);
    await refreshAll();
    showToast(`Closed ${tabIds.length} duplicates`);
    return;
  }
});

// Enter / Space activate the [data-action] elements that are not buttons
// (page chips, "+N more" rows) so the board is keyboard-operable.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  if (!e.target?.closest) return;

  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'BUTTON' || e.target !== el) return;

  e.preventDefault();
  el.click();
});

// Hide images that fail to load. The per-element onerror attribute this
// replaces is blocked by the extension CSP.
document.addEventListener('error', (e) => {
  if (e.target instanceof HTMLImageElement) e.target.style.display = 'none';
}, true);

// ================================================================
// Helper functions
// ================================================================

/**
 * showToast(message)
 * * Transient status line. The previous timer is cleared first so
 *   back-to-back messages each get their full time on screen.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  const toastText = document.getElementById('toastText');
  if (!toast || !toastText) return;

  toastText.textContent = message;
  toast.classList.add('visible');

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * updateTabCountBadge(count)
 * * Update footer badge color based on tab count
 * * 1-10: green, 11-20: amber, 21+: red
 */
function updateTabCountBadge(count) {
  const badge = document.getElementById('statBadge');
  if (!badge) return;

  badge.classList.remove('green', 'amber', 'red');

  if (count <= 10) {
    badge.classList.add('green');
  } else if (count <= 20) {
    badge.classList.add('amber');
  } else {
    badge.classList.add('red');
  }
}

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 6) return 'Good night';
  if (hour < 12) return 'Good morning';
  if (hour < 14) return 'Good afternoon';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function getDateDisplay() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}

/**
 * checkTabOutDupes()
 * * Offer to close the other TreeTab new-tab pages.
 */
async function checkTabOutDupes() {
  const newtabUrl = `chrome-extension://${chrome.runtime.id}/index.html`;
  const openTabs = await chrome.tabs.query({});
  const newtabTabs = openTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  const banner = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');

  if (newtabTabs.length > 1) {
    if (countEl) countEl.textContent = newtabTabs.length;
    if (banner) banner.style.display = 'flex';
  } else {
    if (banner) banner.style.display = 'none';
  }
}

async function refreshAll() {
  try {
    captureScrollPositions();
    await fetchData();
    renderDomains();  // Render domain groups first
    renderGroups();   // Then render tab groups
    restoreScrollPositions();
    checkTabOutDupes();
  } catch (err) {
    // A reloaded/unloaded extension leaves this page with no chrome.* APIs:
    // keep the last board on screen instead of throwing on every event.
    console.error('[TreeTab] Refresh failed:', err);
  }
}

// ================================================================
// Live board — Chrome events re-render the page
// ================================================================

/**
 * scheduleRefresh()
 * * Debounced refreshAll() for Chrome tab/group events: one page load can
 *   emit dozens of them, and they are all one repaint as far as the board
 *   is concerned.
 */
function scheduleRefresh() {
  refreshQueued = true;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(flushRefresh, REFRESH_DEBOUNCE_MS);
}

/**
 * flushRefresh()
 * * Run a queued refresh unless the user is mid-interaction (renaming a
 *   group, dragging a tab) or the page is in the background — the queue flag
 *   stays set so the next event or visibility change picks it up.
 */
async function flushRefresh() {
  if (!refreshQueued) return;
  if (document.hidden || draggedTabId !== null || document.querySelector('.group-title-input')) return;

  refreshQueued = false;
  await refreshAll();
}

/**
 * watchBrowserState()
 * * Subscribe the board to Chrome's tab events. MUST run after the
 *   extension-context gate in init(): a stale page context has no chrome.*
 *   APIs at all, and touching one would throw.
 */
function watchBrowserState() {
  const onChange = () => scheduleRefresh();

  chrome.tabs.onCreated.addListener(onChange);
  chrome.tabs.onRemoved.addListener(onChange);
  chrome.tabs.onMoved.addListener(onChange);
  chrome.tabs.onAttached.addListener(onChange);
  chrome.tabs.onDetached.addListener(onChange);
  chrome.tabs.onReplaced.addListener(onChange);

  // onUpdated also fires for loading/audible changes we do not render
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    const visibleChange = changeInfo.url || changeInfo.title ||
      changeInfo.favIconUrl !== undefined || changeInfo.pinned !== undefined ||
      changeInfo.groupId !== undefined;
    if (visibleChange) onChange();
  });

  chrome.tabGroups.onCreated.addListener(onChange);
  chrome.tabGroups.onMoved.addListener(onChange);
  chrome.tabGroups.onRemoved.addListener(onChange);
  chrome.tabGroups.onUpdated.addListener(onChange);

  // Returning to this window is exactly when the board has to be current
  chrome.windows.onFocusChanged.addListener(id => {
    if (id === pageWindowId) scheduleRefresh();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleRefresh();
  });
}

/**
 * captureScrollPositions() / restoreScrollPositions()
 * * A re-render replaces every card and would reset each group's scroll
 *   offset; remember them so live refreshes do not jump the user around.
 */
function captureScrollPositions() {
  cardScrollPositions.clear();

  document.querySelectorAll('.group-card[data-group-id]').forEach(card => {
    const list = card.querySelector('.group-tabs-list');
    if (list && list.scrollTop > 0) {
      cardScrollPositions.set(card.dataset.groupId, list.scrollTop);
    }
  });
}

function restoreScrollPositions() {
  if (cardScrollPositions.size === 0) return;

  document.querySelectorAll('.group-card[data-group-id]').forEach(card => {
    const offset = cardScrollPositions.get(card.dataset.groupId);
    if (!offset) return;

    const list = card.querySelector('.group-tabs-list');
    if (list) list.scrollTop = offset;
  });
}

// ================================================================
// Tab actions
// ================================================================

/**
 * runTabAction(action, successMessage)
 * * Run a tab mutation, report the outcome, and re-render either way — the
 *   board must never keep showing a tab the browser already moved.
 */
async function runTabAction(action, successMessage) {
  try {
    await action();
    if (successMessage) showToast(successMessage);
    return true;
  } catch (err) {
    console.error('[TreeTab] Tab action failed:', err);
    showToast('Action failed');
    return false;
  } finally {
    await refreshAll();
  }
}

/**
 * focusTab(tabId)
 * * Activate a tab; if it is already gone, repaint instead of doing nothing.
 */
async function focusTab(tabId) {
  if (!tabId || isNaN(tabId)) return;

  try {
    await chrome.tabs.update(tabId, { active: true });
  } catch {
    await refreshAll();
  }
}

/**
 * needsConfirm(el, label)
 * * Two-step guard for bulk destructive buttons: the first click only arms
 *   the button, a second click within CONFIRM_TIMEOUT_MS commits.
 *   Returns true while the button is still unarmed.
 */
function needsConfirm(el, label) {
  if (el.dataset.confirming === '1') {
    resetConfirm(el);
    return false;
  }

  // Only one button is ever armed — arming a new one disarms the rest
  document.querySelectorAll('[data-confirming="1"]').forEach(resetConfirm);

  el.dataset.confirming = '1';
  el.dataset.restingLabel = el.textContent;
  el.textContent = label;
  el.classList.add('confirming');

  clearTimeout(confirmTimer);
  confirmTimer = setTimeout(() => resetConfirm(el), CONFIRM_TIMEOUT_MS);
  return true;
}

function resetConfirm(el) {
  if (!el || el.dataset.confirming !== '1') return;

  el.dataset.confirming = '0';
  el.textContent = el.dataset.restingLabel || el.textContent;
  el.classList.remove('confirming');
}

// ================================================================
// Theme management
// ================================================================

const THEME_KEY = 'treetab-theme';

/**
 * detectDefaultTheme()
 * * Fallback theme when no preference is saved: system > time of day.
 */
function detectDefaultTheme() {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const hour = new Date().getHours();
  const isNight = hour >= 18 || hour < 6;

  return prefersDark || isNight ? 'dark' : 'light';
}

/**
 * extensionApiAvailable()
 * * True when the page runs inside the extension with storage exposed.
 *   A freshly reloaded/unloaded extension can leave a stale new-tab
 *   context stripped of every chrome.* API.
 */
function extensionApiAvailable() {
  return typeof chrome !== 'undefined' && !!(chrome.storage && chrome.storage.local);
}

/**
 * recoverExtensionContextOnce()
 * * On a stale context, reload the page exactly once to re-enter the
 *   extension; sessionStorage guards against a reload loop.
 *   Returns true when a reload was triggered.
 */
function recoverExtensionContextOnce() {
  const RETRY_KEY = 'treetab-context-retry';

  if (!sessionStorage.getItem(RETRY_KEY)) {
    sessionStorage.setItem(RETRY_KEY, '1');
    location.reload();
    return true;
  }
  sessionStorage.removeItem(RETRY_KEY);
  return false;
}

/**
 * initTheme(savedTheme)
 * * Apply the stored theme (or the system/time-of-day default) and keep
 *   following the system preference while the user has not saved one.
 */
function initTheme(savedTheme) {
  applyTheme(savedTheme || detectDefaultTheme());

  // Listen for system theme changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    // Only auto-switch if user has not set manually
    chrome.storage.local.get(THEME_KEY).then(({ [THEME_KEY]: saved }) => {
      if (!saved) {
        applyTheme(e.matches ? 'dark' : 'light');
      }
    });
  });

  // Bind toggle button
  const toggleBtn = document.getElementById('themeToggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', toggleTheme);
  }
}

/**
 * applyTheme(theme)
 * * Apply the given theme
 */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  updateThemeIcon(theme);
}

/**
 * toggleTheme()
 * * Toggle theme and save preference
 */
async function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const newTheme = current === 'dark' ? 'light' : 'dark';

  applyTheme(newTheme);
  await chrome.storage.local.set({ [THEME_KEY]: newTheme });
}

/**
 * updateThemeIcon(theme)
 * * Update the theme toggle icon
 */
function updateThemeIcon(theme) {
  const sunIcon = document.querySelector('.icon-sun');
  const moonIcon = document.querySelector('.icon-moon');

  if (theme === 'dark') {
    if (sunIcon) sunIcon.style.display = 'none';
    if (moonIcon) moonIcon.style.display = 'block';
  } else {
    if (sunIcon) sunIcon.style.display = 'block';
    if (moonIcon) moonIcon.style.display = 'none';
  }
}

// ================================================================
// Custom background management
// ================================================================

const BG_IMAGE_KEY = 'treetab-bg-image';
/** Legacy key from the opacity-slider design, kept only for cleanup */
const BG_OPACITY_KEY_LEGACY = 'treetab-bg-opacity';

/** Longest edge (px) an uploaded image is downscaled to before storage */
const BG_MAX_EDGE = 1600;
/** Encoder quality for the downscaled image */
const BG_IMAGE_QUALITY = 0.85;

/**
 * initBackground(savedImage, legacyOpacityValue)
 * * Render the saved image, wire up controls, sync across pages, and drop
 *   the obsolete opacity-slider setting once.
 */
function initBackground(savedImage, legacyOpacityValue) {
  applyBackgroundLayer(savedImage);
  wireBgResetButton();
  wireBgUploadButton();
  wireBgPopover();
  watchBgStorageChanges();

  if (legacyOpacityValue !== undefined) {
    chrome.storage.local.remove(BG_OPACITY_KEY_LEGACY);
  }
}

/**
 * applyBackgroundLayer(imageDataUrl)
 * * Render (or clear) the full-bleed background layer.
 */
function applyBackgroundLayer(imageDataUrl) {
  const layer = document.getElementById('bgLayer');
  const removeBtn = document.getElementById('bgRemoveBtn');

  if (imageDataUrl && imageDataUrl.startsWith('data:image/')) {
    layer.style.backgroundImage = `url("${imageDataUrl}")`;
    document.body.classList.add('has-bg-image');
    removeBtn.hidden = false;
  } else {
    document.body.classList.remove('has-bg-image');
    removeBtn.hidden = true;
  }
}

/**
 * wireBgUploadButton()
 * * Open the file picker; downscale + persist the chosen image.
 */
function wireBgUploadButton() {
  const uploadBtn = document.getElementById('bgUploadBtn');
  const fileInput = document.getElementById('bgFileInput');

  uploadBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];

    if (file && !file.type.startsWith('image/')) {
      showToast('Please choose an image file');
      fileInput.value = '';
      return;
    }

    if (!file) return;

    try {
      const dataUrl = await downscaleImage(file);
      await chrome.storage.local.set({ [BG_IMAGE_KEY]: dataUrl });
      applyBackgroundLayer(dataUrl);
      closeBgPopover();
      showToast('Background image saved');
    } catch (err) {
      showToast('Could not save this image (too large?)');
    } finally {
      fileInput.value = '';
    }
  });
}

/**
 * downscaleImage(file)
 * * Downscale to BG_MAX_EDGE and re-encode as WebP so the data URL fits
 *   in chrome.storage.local's quota (default 10 MB).
 */
async function downscaleImage(file) {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImageIntoElement(objectUrl);
    const scale = Math.min(1, BG_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);

    return canvas.toDataURL('image/webp', BG_IMAGE_QUALITY);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function loadImageIntoElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image decode failed'));
    img.src = src;
  });
}

/**
 * wireBgResetButton()
 * * Remove the stored image after the layer fade-out completes.
 */
function wireBgResetButton() {
  const removeBtn = document.getElementById('bgRemoveBtn');

  removeBtn.addEventListener('click', async () => {
    const layer = document.getElementById('bgLayer');

    document.body.classList.remove('has-bg-image');
    removeBtn.hidden = true;
    await chrome.storage.local.remove(BG_IMAGE_KEY);

    setTimeout(() => {
      if (document.body.classList.contains('has-bg-image')) return;
      layer.style.backgroundImage = '';
    }, 400);

    closeBgPopover();
    showToast('Background image removed');
  });
}

/**
 * closeBgPopover()
 * * Hide the background settings panel and reset its button state.
 */
function closeBgPopover() {
  const btn = document.getElementById('bgToggleBtn');
  const popover = document.getElementById('bgPopover');
  if (!btn || !popover) return;

  popover.hidden = true;
  btn.classList.remove('active');
  btn.setAttribute('aria-expanded', 'false');
}

/**
 * wireBgPopover()
 * * Open/close the settings popover; dismiss on outside click or Escape.
 */
function wireBgPopover() {
  const btn = document.getElementById('bgToggleBtn');
  const popover = document.getElementById('bgPopover');

  btn.addEventListener('click', () => {
    const willOpen = popover.hidden;
    popover.hidden = !willOpen;
    btn.classList.toggle('active', willOpen);
    btn.setAttribute('aria-expanded', String(willOpen));
  });

  document.addEventListener('click', (e) => {
    if (!popover.hidden && !popover.contains(e.target) && !btn.contains(e.target)) {
      closeBgPopover();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeBgPopover();
  });
}

/**
 * watchBgStorageChanges()
 * * Keep the layer in sync when another tab page saves/removes a background.
 */
function watchBgStorageChanges() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[BG_IMAGE_KEY]) return;

    // The event already carries the new value — no second storage read
    applyBackgroundLayer(changes[BG_IMAGE_KEY].newValue);
  });
}

// ================================================================
// Initialization
// ================================================================

async function init() {
  document.getElementById('greeting').textContent = getGreeting();
  document.getElementById('dateDisplay').textContent = getDateDisplay();

  if (!extensionApiAvailable()) {
    // Stale context without chrome APIs: re-enter the extension once,
    // then degrade gracefully without touching any chrome.* API.
    if (recoverExtensionContextOnce()) return;
    applyTheme(detectDefaultTheme());
    return;
  }

  // One storage round-trip covers every persisted preference
  const stored = await chrome.storage.local.get([
    THEME_KEY,
    BG_IMAGE_KEY,
    BG_OPACITY_KEY_LEGACY,
  ]);

  initTheme(stored[THEME_KEY]);
  initBackground(stored[BG_IMAGE_KEY], stored[BG_OPACITY_KEY_LEGACY]);

  await refreshAll();
  setupNewGroupDropzone();
  watchBrowserState();
}

document.addEventListener('DOMContentLoaded', init);
