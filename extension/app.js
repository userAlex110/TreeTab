/* ================================================================
   TreeTab —— 整合版本
   上方：浏览器标签组（横向滚动，可拖拽管理）
   下方：按域名分组的标签页（原有功能）

   功能：
   1. 显示浏览器自带的标签组，支持拖拽管理
   2. 按域名分组展示所有标签页
   3. 主页特殊分组
   4. 重复标签检测
   5. 关闭动效（音效 + 彩纸）
   ================================================================ */

'use strict';

// ================================================================
// 全局状态
// ================================================================

let allTabs = [];
let allGroups = [];
let domainGroups = [];
let draggedTabId = null;

const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan'];

// ================================================================
// 数据获取
// ================================================================

async function fetchData() {
  try {
    const currentWindow = await chrome.windows.getCurrent();
    const [tabs, groups] = await Promise.all([
      chrome.tabs.query({ currentWindow: true }),
      chrome.tabGroups.query({ windowId: currentWindow.id })
    ]);

    // 过滤掉内部页面
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

    // 更新统计
    const tabCount = allTabs.length;
    document.getElementById('statTabs').textContent = tabCount;
    updateTabCountBadge(tabCount);

    return { tabs: allTabs, groups: allGroups };
  } catch (err) {
    console.error('[TreeTab] 获取数据失败:', err);
    showToast('获取数据失败');
    return { tabs: [], groups: [] };
  }
}

// ================================================================
// 标签组区域渲染（上方）
// ================================================================

function renderGroups() {
  const container = document.getElementById('groupsContainer');
  const countEl = document.getElementById('groupsCount');

  if (!container) return;
  container.innerHTML = '';

  // 统计有标签的组
  const groupTabsMap = {};
  for (const tab of allTabs) {
    if (tab.groupId && tab.groupId !== -1) {
      if (!groupTabsMap[tab.groupId]) groupTabsMap[tab.groupId] = [];
      groupTabsMap[tab.groupId].push(tab);
    }
  }

  const activeGroups = allGroups.filter(g => groupTabsMap[g.id]?.length > 0);
  countEl.textContent = `${activeGroups.length} 个分组`;

  // 渲染每个组
  for (const group of activeGroups) {
    const groupCard = createGroupCard(group, groupTabsMap[group.id]);
    container.appendChild(groupCard);
  }

  // 未分组的标签也显示一个特殊卡片
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
    <div class="group-title" data-group-id="${group.id}">${group.title || '未命名分组'}</div>
    <div class="group-actions">
      <button class="group-action-btn group-edit-btn" data-action="edit-group-name" data-group-id="${group.id}" title="重命名">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Zm0 0L19.5 7.125" />
        </svg>
      </button>
      <button class="group-action-btn group-close-btn" data-action="delete-group" data-group-id="${group.id}" title="删除分组">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
    <div class="group-count">${tabs.length}</div>
  `;

  // 点击组名也可以编辑
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

  // 拖拽事件
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
    <div class="group-title">未分组</div>
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

  // 未分组区域也支持放置（移动过来就是取消分组）
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

  const rawTitle = stripTitleSuffix(tab.title || tab.url || '无标题');
  const title = getCustomTitle(rawTitle, tab.url);

  el.innerHTML = `
    <img class="group-tab-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">
    <div class="group-tab-title" title="${(title || '').replace(/"/g, '&quot;')}">${title}</div>
    <div class="group-tab-actions">
      <button class="group-tab-action group-tab-close" data-tab-id="${tab.id}" title="关闭标签页">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  `;

  // 点击切换标签页
  el.addEventListener('click', (e) => {
    if (e.target.closest('.group-tab-action')) return;
    chrome.tabs.update(tab.id, { active: true });
  });

  // 关闭按钮（X）- 完全关闭标签页
  const closeBtn = el.querySelector('.group-tab-close');
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(tab.id, el);
  });

  // 拖拽事件
  el.addEventListener('dragstart', handleDragStart);
  el.addEventListener('dragend', handleDragEnd);

  return el;
}

// ================================================================
// 拖拽逻辑
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

// 域名分组标签页的拖拽处理
function handleDomainDragStart(e) {
  const chip = e.target.closest('.page-chip');
  if (!chip) return;

  // 获取 tab ID（从 data 属性）
  const tabId = parseInt(chip.dataset.tabId, 10);
  if (!tabId || isNaN(tabId)) return;

  draggedTabId = tabId;
  chip.classList.add('dragging');

  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(tabId));

  // 拖拽时显示提示
  showToast('拖拽到下方标签组或新建分组区域');
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
      showToast('已移动到分组');
      await refreshAll();
    } catch (err) {
      console.error('移动失败:', err);
      showToast('移动失败');
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
      showToast('已移出分组');
      await refreshAll();
    } catch (err) {
      console.error('移动失败:', err);
      showToast('移动失败');
    }
  });
}

// 新建分组放置区
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
        title: '新分组'
      });
      showToast('已创建新分组');
      await refreshAll();
    } catch (err) {
      console.error('创建分组失败:', err);
      showToast('创建分组失败');
    }
  });
}

// ================================================================
// 标签组操作函数
// ================================================================

/**
 * editGroupName(groupId, titleEl)
 * 编辑标签组名称
 */
async function editGroupName(groupId, titleEl) {
  const currentTitle = titleEl.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentTitle;
  input.className = 'group-title-input';

  // 替换标题为输入框
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  // 保存函数
  const save = async () => {
    const newTitle = input.value.trim();
    if (newTitle && newTitle !== currentTitle) {
      try {
        await chrome.tabGroups.update(groupId, { title: newTitle });
        showToast('分组名称已更新');
        await refreshAll();
      } catch (err) {
        console.error('重命名失败:', err);
        showToast('重命名失败');
        titleEl.textContent = currentTitle;
        input.replaceWith(titleEl);
      }
    } else {
      // 没有变化，恢复原样
      input.replaceWith(titleEl);
    }
  };

  // 回车保存，ESC 取消
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      input.replaceWith(titleEl);
    }
  });

  // 失去焦点保存
  input.addEventListener('blur', save);
}

/**
 * deleteGroup(groupId)
 * 删除标签组，同时关闭组内所有标签页
 */
async function deleteGroup(groupId) {
  const groupTabs = allTabs.filter(t => t.groupId === groupId);
  if (groupTabs.length === 0) return;

  const tabIds = groupTabs.map(t => t.id);

  try {
    playCloseSound();
    // 关闭所有标签页并删除分组
    await chrome.tabs.remove(tabIds);
    await chrome.tabGroups.remove(groupId);
    showToast('分组和标签页已删除');
    await refreshAll();
  } catch (err) {
    console.error('删除分组失败:', err);
    showToast('删除失败');
  }
}

// ================================================================
// 域名分组区域渲染（下方）- 原有功能
// ================================================================

// 主页 URL 模式
const LANDING_PAGE_PATTERNS = [
  { hostname: 'mail.google.com', test: (p, h) => !h.includes('#inbox/') && !h.includes('#sent/') },
  { hostname: 'x.com', pathExact: ['/home'] },
  { hostname: 'www.linkedin.com', pathExact: ['/'] },
  { hostname: 'github.com', pathExact: ['/'] },
  { hostname: 'www.youtube.com', pathExact: ['/'] },
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
      // 跳过无效 URL
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  // 排序：主页优先，然后按标签数量
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
 * 针对特定域名提取更有意义的标题
 */
function getCustomTitle(title, url) {
  if (!url) return title;

  try {
    const parsed = new URL(url);

    // 成都大学 ehall 系统
    if (parsed.hostname === 'ehall.cdu.edu.cn') {
      const hash = parsed.hash || '';
      const actMatch = hash.match(/act=([^&]+)/);

      if (actMatch) {
        const act = actMatch[1]; // 例如: fp/svsmng/processMng 或 fp/printing

        // 特殊名称映射表（覆盖自动提取）
        const SPECIAL_NAMES = {
          'fp/formHome': '首页',
        };

        // 尝试从映射表获取友好名称
        let actName = SPECIAL_NAMES[act];

        // 如果没有映射，自动提取最后一部分并格式化
        if (!actName) {
          // 提取最后一段路径，例如 fp/svsmng/processMng -> processMng
          const parts = act.split('/');
          const lastPart = parts[parts.length - 1];

          // 格式化驼峰命名: processMng -> 流程管理, formDesign -> 表单设计
          actName = formatCamelCase(lastPart);
        }

        // 提取 ID 如果有
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
    // 解析失败返回原标题
  }

  return title;
}

/**
 * formatCamelCase(str)
 * 将驼峰命名转换为中文友好格式
 * 例如: processMng -> 流程管理, formDesign -> 表单设计
 */
function formatCamelCase(str) {
  if (!str) return '';

  // 常见词汇映射
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

  // 尝试直接匹配整个单词（不区分大小写）
  const lowerStr = str.toLowerCase();
  for (const [en, cn] of Object.entries(VOCAB)) {
    if (lowerStr === en.toLowerCase()) {
      return cn;
    }
  }

  // 尝试分解驼峰命名
  // 例如: processMng -> ['process', 'Mng'] -> 流程管理
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
  countEl.innerHTML = `${domainGroups.length} 个域名`;

  for (const group of domainGroups) {
    const card = createDomainCard(group);
    container.appendChild(card);
  }

  // 给所有域名分组的标签页芯片添加拖拽事件
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

  // 统计重复
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const card = document.createElement('div');
  card.className = `mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}`;

  // 徽章
  let badgesHtml = `<span class="open-tabs-badge">
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" style="width:10px;height:10px">
      <path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" />
    </svg>
    ${tabCount} tabs
  </span>`;

  if (hasDupes) {
    badgesHtml += `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">${totalExtras} duplicates</span>`;
  }

  // 标签芯片
  const seen = new Set();
  const uniqueTabs = tabs.filter(t => {
    if (seen.has(t.url)) return false;
    seen.add(t.url);
    return true;
  });

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount = uniqueTabs.length - visibleTabs.length;

  let chipsHtml = visibleTabs.map(tab => {
    // 使用自定义标题处理
    const rawTitle = stripTitleSuffix(tab.title || tab.url);
    const label = getCustomTitle(rawTitle, tab.url);
    const count = urlCounts[tab.url];
    const dupeTag = count > 1 ? `<span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? 'chip-has-dupes' : '';

    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';

    // 给每个标签页芯片添加 draggable 属性和 tab ID
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

  // 操作按钮
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
// 关闭动效（音效 + 彩纸）
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
      z-index: 9999;
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
    // 动画
    element.style.transition = 'opacity 0.2s, transform 0.2s';
    element.style.opacity = '0';
    element.style.transform = 'scale(0.9)';

    // 彩纸效果
    const rect = element.getBoundingClientRect();
    shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
    playCloseSound();

    await new Promise(r => setTimeout(r, 200));
    await chrome.tabs.remove(tabId);
    await refreshAll();
  } catch (err) {
    console.error('关闭失败:', err);
  }
}

// ================================================================
// 事件处理
// ================================================================

document.addEventListener('click', async (e) => {
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  // 关闭重复 TreeTab 页面
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
      showToast('已关闭额外的 TreeTab 页面');
    }
    return;
  }

  // 切换标签页
  if (action === 'focus-tab') {
    const url = actionEl.dataset.tabUrl;
    const tab = allTabs.find(t => t.url === url);
    if (tab) await chrome.tabs.update(tab.id, { active: true });
    return;
  }

  // 关闭单个标签
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

  // 编辑标签组名称
  if (action === 'edit-group-name') {
    e.stopPropagation();
    const groupId = parseInt(actionEl.dataset.groupId, 10);
    const titleEl = actionEl.closest('.group-header').querySelector('.group-title');
    if (groupId && titleEl) {
      editGroupName(groupId, titleEl);
    }
    return;
  }

  // 删除标签组（分组和标签页都删除）
  if (action === 'delete-group') {
    e.stopPropagation();
    const groupId = parseInt(actionEl.dataset.groupId, 10);
    if (groupId) {
      const group = allGroups.find(g => g.id === groupId);
      const groupTabs = allTabs.filter(t => t.groupId === groupId);
      if (confirm(`确定要删除"${group?.title || '该分组'}"吗？\n\n组内 ${groupTabs.length} 个标签页将被关闭，分组也会被删除。`)) {
        await deleteGroup(groupId);
      }
    }
    return;
  }

  // 关闭整个域名组
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
      showToast(`已关闭 ${toClose.length} 个标签页`);
    }
    return;
  }

  // 去重
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
      showToast('已关闭重复标签页');
    }
    return;
  }
});

// ================================================================
// 辅助函数
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
 * 根据标签数量更新页脚徽章颜色
 * 1-10: 绿色, 11-20: 琥珀色, 21+: 红色
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
  if (hour < 6) return '夜深了';
  if (hour < 12) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

function getDateDisplay() {
  return new Date().toLocaleDateString('zh-CN', {
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
  renderDomains();  // 先渲染域名分组
  renderGroups();   // 后渲染标签组
  checkTabOutDupes();
}

// ================================================================
// 主题管理
// ================================================================

const THEME_KEY = 'treetab-theme';

/**
 * initTheme()
 * 初始化主题，优先使用保存的偏好，其次检测系统主题，最后根据时间
 */
async function initTheme() {
  // 尝试从 storage 读取用户偏好
  const { [THEME_KEY]: savedTheme } = await chrome.storage.local.get(THEME_KEY);

  if (savedTheme) {
    // 用户有保存的偏好
    applyTheme(savedTheme);
  } else {
    // 检测系统偏好
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    // 或者根据时间（晚上6点到早上6点自动深色）
    const hour = new Date().getHours();
    const isNight = hour >= 18 || hour < 6;

    const theme = prefersDark || isNight ? 'dark' : 'light';
    applyTheme(theme);
  }

  // 监听系统主题变化
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    // 只有在用户没有手动设置时才自动切换
    chrome.storage.local.get(THEME_KEY).then(({ [THEME_KEY]: saved }) => {
      if (!saved) {
        applyTheme(e.matches ? 'dark' : 'light');
      }
    });
  });

  // 绑定切换按钮
  const toggleBtn = document.getElementById('themeToggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', toggleTheme);
  }
}

/**
 * applyTheme(theme)
 * 应用指定主题
 */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  updateThemeIcon(theme);
}

/**
 * toggleTheme()
 * 切换主题并保存偏好
 */
async function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const newTheme = current === 'dark' ? 'light' : 'dark';

  applyTheme(newTheme);
  await chrome.storage.local.set({ [THEME_KEY]: newTheme });
}

/**
 * updateThemeIcon(theme)
 * 更新主题切换按钮图标
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
// 初始化
// ================================================================

async function init() {
  document.getElementById('greeting').textContent = getGreeting();
  document.getElementById('dateDisplay').textContent = getDateDisplay();

  await initTheme();
  await refreshAll();
  setupNewGroupDropzone();
}

document.addEventListener('DOMContentLoaded', init);
