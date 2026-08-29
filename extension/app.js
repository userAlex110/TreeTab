/* ================================================================
   TreeTab — New Tab Dashboard
   Top: Browser tab groups (masonry layout, drag to manage)
   Bottom: Domain-grouped tabs (original feature)

   Features:
   1. Display browser tab groups with drag-and-drop management
   2. Group tabs by domain
   3. Landing page detection
   4. Duplicate tab detection
   5. Close animation (sound + confetti)
   ================================================================ */

'use strict';

// ================================================================
// Global state
// ================================================================

let allTabs = [];
let allGroups = [];
let domainGroups = [];
let draggedTabId = null;

const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan'];

// ================================================================
// Data fetching
// ================================================================

async function fetchData() {
  try {
    const currentWindow = await chrome.windows.getCurrent();
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
  countEl.textContent = `${activeGroups.length} groups`;

  // Render each group
  for (const group of activeGroups) {
    const groupCard = createGroupCard(group, groupTabsMap[group.id]);
    container.appendChild(groupCard);
  }

  // Show ungrouped tabs as a special card
  const ungroupedTabs = allTabs.filter(t => !t.groupId || t.groupId === -1);
  if (ungroupedTabs.length > 0) {
    const ungroupedCard = createUngroupedCard(ungroupedTabs);
    container.appendChild(ungroupedCard);
  }
}

function createGroupCard(group, tabs) {
  const card = document.createElement('div');
  card.className = 'group-card';
  card.dataset.groupId = group.id;

  const header = document.createElement('div');
  header.className = 'group-header';
  header.innerHTML = `
    <div class="group-color group-color-${group.color}"></div>
    <div class="group-title" data-group-id="${group.id}">${group.title || 'Unnamed Group'}</div>
    <div class="group-actions">
      <button class="group-action-btn group-edit-btn" data-action="edit-group-name" data-group-id="${group.id}" title="Rename">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Zm0 0L19.5 7.125" />
        </svg>
      </button>
      <button class="group-action-btn group-close-btn" data-action="delete-group" data-group-id="${group.id}" title="Delete group">
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

  // Drag events
  setupDropZone(card, group.id);

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

  for (const tab of tabs) {
    const tabEl = createGroupTabElement(tab);
    tabsList.appendChild(tabEl);
  }

  card.appendChild(header);
  card.appendChild(tabsList);

  // Drop here to ungroup
  setupUngroupedDropZone(card);

  return card;
}

function createGroupTabElement(tab) {
  const el = document.createElement('div');
  el.className = 'group-tab-item';
  el.draggable = true;
  el.dataset.tabId = tab.id;

  let domain = '';
  let faviconUrl = '';
  try {
    const url = new URL(tab.url);
    domain = url.hostname.replace(/^www\./, '');
    faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  } catch {
    faviconUrl = tab.favIconUrl || '';
  }

  const rawTitle = stripTitleSuffix(tab.title || tab.url || 'Untitled');
  const title = getCustomTitle(rawTitle, tab.url);

  el.innerHTML = `
    <img class="group-tab-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">
    <div class="group-tab-title" title="${(title || '').replace(/"/g, '&quot;')}">${title}</div>
    <div class="group-tab-actions">
      <button class="group-tab-action group-tab-close" data-tab-id="${tab.id}" title="Close tab">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  `;

  // Click to switch to tab
  el.addEventListener('click', (e) => {
    if (e.target.closest('.group-tab-action')) return;
    chrome.tabs.update(tab.id, { active: true });
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

function handleDragStart(e) {
  const item = e.target.closest('.group-tab-item');
  if (!item) return;

  draggedTabId = parseInt(item.dataset.tabId, 10);
  item.classList.add('dragging');

  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(draggedTabId));
}

function handleDragEnd(e) {
  const item = e.target.closest('.group-tab-item');
  if (item) item.classList.remove('dragging');

  document.querySelectorAll('.group-card, .new-group-dropzone').forEach(el => {
    el.classList.remove('drag-over');
  });

  draggedTabId = null;
}

// Domain group tab drag handling
function handleDomainDragStart(e) {
  const chip = e.target.closest('.page-chip');
  if (!chip) return;

  // Get tab ID from data attribute
  const tabId = parseInt(chip.dataset.tabId, 10);
  if (!tabId || isNaN(tabId)) return;

  draggedTabId = tabId;
  chip.classList.add('dragging');

  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(tabId));

  // Show hint during drag
  showToast('Drop onto a group or the new group zone');
}

function handleDomainDragEnd(e) {
  const chip = e.target.closest('.page-chip');
  if (chip) chip.classList.remove('dragging');

  document.querySelectorAll('.group-card, .new-group-dropzone').forEach(el => {
    el.classList.remove('drag-over');
  });

  draggedTabId = null;
}

function setupDropZone(element, groupId) {
  element.addEventListener('dragover', (e) => {
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

    const tabId = parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (!tabId || isNaN(tabId)) return;

    const tab = allTabs.find(t => t.id === tabId);
    if (!tab || tab.groupId === groupId) return;

    try {
      await chrome.tabs.group({ groupId, tabIds: [tabId] });
      showToast('Moved to group');
      await refreshAll();
    } catch (err) {
      console.error('Move failed:', err);
      showToast('Move failed');
    }
  });
}

function setupUngroupedDropZone(element) {
  element.addEventListener('dragover', (e) => {
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

    const tabId = parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (!tabId || isNaN(tabId)) return;

    const tab = allTabs.find(t => t.id === tabId);
    if (!tab || !tab.groupId || tab.groupId === -1) return;

    try {
      await chrome.tabs.ungroup(tabId);
      showToast('Removed from group');
      await refreshAll();
    } catch (err) {
      console.error('Move failed:', err);
      showToast('Move failed');
    }
  });
}

// New group drop zone setup
function setupNewGroupDropzone() {
  const dropzone = document.getElementById('newGroupDropzone');
  if (!dropzone) return;

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    dropzone.classList.add('drag-over');
  });

  dropzone.addEventListener('dragleave', (e) => {
    if (!dropzone.contains(e.relatedTarget)) {
      dropzone.classList.remove('drag-over');
    }
  });

  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');

    const tabId = parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (!tabId || isNaN(tabId)) return;

    try {
      const randomColor = GROUP_COLORS[Math.floor(Math.random() * GROUP_COLORS.length)];
      const newGroupId = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(newGroupId, {
        color: randomColor,
        title: 'New Group'
      });
      showToast('New group created');
      await refreshAll();
    } catch (err) {
      console.error('Failed to create group:', err);
      showToast('Failed to create group');
    }
  });
}

// ================================================================
// Tab group operations
// ================================================================

/**
 * editGroupName(groupId, titleEl)
 * * Edit a tab group name
 */
async function editGroupName(groupId, titleEl) {
  const currentTitle = titleEl.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentTitle;
  input.className = 'group-title-input';

  // Replace title with input
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  // Save function
  const save = async () => {
    const newTitle = input.value.trim();
    if (newTitle && newTitle !== currentTitle) {
      try {
        await chrome.tabGroups.update(groupId, { title: newTitle });
        showToast('Group renamed');
        await refreshAll();
      } catch (err) {
        console.error('Rename failed:', err);
        showToast('Rename failed');
        titleEl.textContent = currentTitle;
        input.replaceWith(titleEl);
      }
    } else {
      // No change, restore original
      input.replaceWith(titleEl);
    }
  };

  // Enter to save, ESC to cancel
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      input.replaceWith(titleEl);
    }
  });

  // Save on blur
  input.addEventListener('blur', save);
}

/**
 * deleteGroup(groupId)
 * * Delete a tab group and close all its tabs
 */
async function deleteGroup(groupId) {
  const groupTabs = allTabs.filter(t => t.groupId === groupId);
  if (groupTabs.length === 0) return;

  const tabIds = groupTabs.map(t => t.id);

  try {
    playCloseSound();
    // Close all tabs and remove group
    await chrome.tabs.remove(tabIds);
    await chrome.tabGroups.remove(groupId);
    showToast('Group and tabs deleted');
    await refreshAll();
  } catch (err) {
    console.error('Failed to delete group:', err);
    showToast('Delete failed');
  }
}

// ================================================================
// Domain grouping rendering (bottom) — original feature
// ================================================================

// Landing page URL patterns
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

      let hostname = tab.url?.startsWith('file://')
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
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  // Sort: landing pages first, then by tab count
  return Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;
    return b.tabs.length - a.tabs.length;
  });
}

function friendlyDomain(hostname) {
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

        // Special name mapping (overrides auto-extraction)
        const SPECIAL_NAMES = {
          'fp/formHome': '首页',
          'fp/svsmng': '服务配置管理',
          'fp/printing': '打印模板管理',
        };

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

  // Common vocabulary mapping
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

  if (!container) return;
  container.innerHTML = '';

  domainGroups = organizeByDomain(allTabs);

  if (domainGroups.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  countEl.innerHTML = `${domainGroups.length} domains`;

  for (const group of domainGroups) {
    const card = createDomainCard(group);
    container.appendChild(card);
  }

  // Add drag events to all domain group tab chips
  const chips = container.querySelectorAll('.page-chip[draggable="true"]');
  chips.forEach(chip => {
    chip.addEventListener('dragstart', handleDomainDragStart);
    chip.addEventListener('dragend', handleDomainDragEnd);
  });
}

function createDomainCard(group) {
  const tabs = group.tabs;
  const tabCount = tabs.length;
  const isLanding = group.domain === '__landing-pages__';

  // Count duplicates
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const card = document.createElement('div');
  card.className = `mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}`;

  // Badges
  let badgesHtml = `<span class="open-tabs-badge">
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" style="width:10px;height:10px">
      <path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" />
    </svg>
    ${tabCount} tabs
  </span>`;

  if (hasDupes) {
    badgesHtml += `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">${totalExtras} duplicates</span>`;
  }

  // Tab chips
  const seen = new Set();
  const uniqueTabs = tabs.filter(t => {
    if (seen.has(t.url)) return false;
    seen.add(t.url);
    return true;
  });

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount = uniqueTabs.length - visibleTabs.length;

  let chipsHtml = visibleTabs.map(tab => {
    // Use custom title
    const rawTitle = stripTitleSuffix(tab.title || tab.url);
    const label = getCustomTitle(rawTitle, tab.url);
    const count = urlCounts[tab.url];
    const dupeTag = count > 1 ? `<span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? 'chip-has-dupes' : '';

    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';

    // Add draggable and tab ID to chips
    return `<div class="page-chip clickable ${chipClass}"
      draggable="true"
      data-tab-id="${tab.id}"
      data-tab-url="${tab.url}"
      data-action="focus-tab">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${tab.url}" title="Close tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  if (extraCount > 0) {
    chipsHtml += `<div class="page-chip page-chip-overflow" data-action="expand-chips">+${extraCount} more</div>`;
  }

  // Action buttons
  let actionsHtml = `<button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain="${group.domain}">Close all ${tabCount} tabs</button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `<button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">Close ${totalExtras} duplicates</button>`;
  }

  card.innerHTML = `
    <div class="mission-content">
      <div class="mission-top">
        <span class="mission-name">${isLanding ? 'Homepages' : friendlyDomain(group.domain)}</span>
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

function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
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

    setTimeout(() => ctx.close(), 500);
  } catch {}
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

async function closeTab(tabId, element) {
  try {
    // Animation
    element.style.transition = 'opacity 0.2s, transform 0.2s';
    element.style.opacity = '0';
    element.style.transform = 'scale(0.9)';

    // Confetti effect
    const rect = element.getBoundingClientRect();
    shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
    playCloseSound();

    await new Promise(r => setTimeout(r, 200));
    await chrome.tabs.remove(tabId);
    await refreshAll();
  } catch (err) {
    console.error('Close failed:', err);
  }
}

// ================================================================
// Event handling
// ================================================================

document.addEventListener('click', async (e) => {
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  // Close duplicate TreeTab tabs
  if (action === 'close-tabout-dupes') {
    const extensionId = chrome.runtime.id;
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;
    const allTabs = await chrome.tabs.query({});
    const currentWindow = await chrome.windows.getCurrent();
    const tabOutTabs = allTabs.filter(t =>
      t.url === newtabUrl || t.url === 'chrome://newtab/'
    );

    if (tabOutTabs.length > 1) {
      const keep = tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
                   tabOutTabs.find(t => t.active) ||
                   tabOutTabs[0];
      const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
      if (toClose.length > 0) await chrome.tabs.remove(toClose);

      playCloseSound();
      const banner = document.getElementById('tabOutDupeBanner');
      if (banner) banner.style.display = 'none';
      showToast('Closed extra TreeTab tabs');
    }
    return;
  }

  // Switch to tab
  if (action === 'focus-tab') {
    const url = actionEl.dataset.tabUrl;
    const tab = allTabs.find(t => t.url === url);
    if (tab) await chrome.tabs.update(tab.id, { active: true });
    return;
  }

  // Close single tab
  if (action === 'close-single-tab') {
    e.stopPropagation();
    const url = actionEl.dataset.tabUrl;
    const tab = allTabs.find(t => t.url === url);
    if (tab) {
      const chip = actionEl.closest('.page-chip');
      await closeTab(tab.id, chip);
    }
    return;
  }

  // Edit group name
  if (action === 'edit-group-name') {
    e.stopPropagation();
    const groupId = parseInt(actionEl.dataset.groupId, 10);
    const titleEl = actionEl.closest('.group-header').querySelector('.group-title');
    if (groupId && titleEl) {
      editGroupName(groupId, titleEl);
    }
    return;
  }

  // Delete group (both group and tabs)
  if (action === 'delete-group') {
    e.stopPropagation();
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

  // Close entire domain group
  if (action === 'close-domain-tabs') {
    const domain = actionEl.dataset.domain;
    const group = domainGroups.find(g => g.domain === domain);
    if (!group) return;

    const urls = group.tabs.map(t => t.url);
    const useExact = domain === '__landing-pages__';

    const allTabs = await chrome.tabs.query({});
    const toClose = [];

    if (useExact) {
      const urlSet = new Set(urls);
      toClose.push(...allTabs.filter(t => urlSet.has(t.url)).map(t => t.id));
    } else {
      const targetHostnames = urls.map(u => {
        try { return new URL(u).hostname; } catch { return null; }
      }).filter(Boolean);

      toClose.push(...allTabs.filter(t => {
        try { return targetHostnames.includes(new URL(t.url).hostname); }
        catch { return false; }
      }).map(t => t.id));
    }

    if (toClose.length > 0) {
      playCloseSound();
      const card = actionEl.closest('.mission-card');
      if (card) {
        const rect = card.getBoundingClientRect();
        shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
        card.classList.add('closing');
      }

      await chrome.tabs.remove(toClose);
      await refreshAll();
      showToast(`Closed ${toClose.length} tabs`);
    }
    return;
  }

  // Deduplication
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    const allTabs = await chrome.tabs.query({});
    const toClose = [];

    for (const url of urls) {
      const matching = allTabs.filter(t => t.url === url);
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    }

    if (toClose.length > 0) {
      playCloseSound();
      await chrome.tabs.remove(toClose);
      await refreshAll();
      showToast('Duplicates closed');
    }
    return;
  }
});

// ================================================================
// Helper functions
// ================================================================

function showToast(message) {
  const toast = document.getElementById('toast');
  const toastText = document.getElementById('toastText');
  if (!toast || !toastText) return;

  toastText.textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
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

async function checkTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;
  const allTabs = await chrome.tabs.query({});
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  const banner = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
    if (banner) banner.style.display = 'flex';
  } else {
    if (banner) banner.style.display = 'none';
  }
}

async function refreshAll() {
  await fetchData();
  renderDomains();  // Render domain groups first
  renderGroups();   // Then render tab groups
  checkTabOutDupes();
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
 * initTheme()
 * * Init theme: saved preference > system preference > time of day
 */
async function initTheme() {
  // Try reading saved preference from storage
  const { [THEME_KEY]: savedTheme } = await chrome.storage.local.get(THEME_KEY);

  if (savedTheme) {
    // User has a saved preference
    applyTheme(savedTheme);
  } else {
    applyTheme(detectDefaultTheme());
  }

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
 * initBackground()
 * * Load the saved image, render the layer, wire up controls.
 */
async function initBackground() {
  const { [BG_IMAGE_KEY]: savedImage } = await chrome.storage.local.get(BG_IMAGE_KEY);

  applyBackgroundLayer(savedImage);
  wireBgResetButton();
  wireBgUploadButton();
  wireBgPopover();
  watchBgStorageChanges();

  // One-time cleanup of the obsolete opacity-slider setting
  chrome.storage.local.remove(BG_OPACITY_KEY_LEGACY);
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
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !changes[BG_IMAGE_KEY]) return;

    const { [BG_IMAGE_KEY]: image } = await chrome.storage.local.get(BG_IMAGE_KEY);
    applyBackgroundLayer(image);
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

  await initTheme();
  await initBackground();
  await refreshAll();
  setupNewGroupDropzone();
}

document.addEventListener('DOMContentLoaded', init);
