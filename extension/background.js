/**
 * background.js — Service worker
 *
 * Two jobs, both local:
 * 1. Toolbar badge: how many real web tabs are open, coloured by the shared
 *    tier table in shared.js.
 * 2. Recently closed tray: remember a modest list of pages the user just
 *    closed, so the new-tab page can reopen them without the "sessions"
 *    permission (and without sync). Snapshots live in chrome.storage.session
 *    because a service worker is torn down after ~30s idle; onRemoved only
 *    receives a tab id, so the URL has to be saved before the close.
 */

importScripts('shared.js');

// ─── Badge updater ────────────────────────────────────────────────────────────

/**
 * updateBadge()
 * * Counts open real-web tabs and updates the extension's toolbar badge.
 *   "Real" tabs = not browser internals and not extension pages.
 */
async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});
    const count = tabs.filter(tab => !isInternalPageUrl(tab.url)).length;

    // Don't show "0" — an empty badge is cleaner
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });

    if (count === 0) return;

    await chrome.action.setBadgeBackgroundColor({ color: tabLoadTier(count).color });
  } catch {
    try {
      await chrome.action.setBadgeText({ text: '' });
    } catch { /* the toolbar is unreachable; nothing left to update */ }
  }
}

/**
 * scheduleBadgeUpdate()
 * * Coalesces a burst of tab events into one updateBadge() run.
 *   A page load fires many onUpdated events in a row, and a service worker is
 *   torn down after ~30s idle — so this chains onto the previous run instead of
 *   holding a setTimeout handle in a global. The flag is self-healing: it only
 *   needs to live as long as the burst, and the next event re-arms it.
 */
let badgeChain = Promise.resolve();
let badgeQueued = false;

function scheduleBadgeUpdate() {
  if (badgeQueued) return;
  badgeQueued = true;
  badgeChain = badgeChain.then(() => {
    badgeQueued = false;
    return updateBadge();
  });
}

// ─── Recently closed ──────────────────────────────────────────────────────────

/**
 * sessionChain
 * * Snapshot writes and "record a close" reads share one queue. Two closes in
 *   the same tick would otherwise read the same list and drop one of them.
 *   The chain is coordination, not the list itself — the list lives in
 *   chrome.storage.local and survives the worker.
 */
let sessionChain = Promise.resolve();

function enqueueSession(task) {
  sessionChain = sessionChain.then(task, task);
  return sessionChain;
}

function snapshotFromTab(tab) {
  const url = tab.url || tab.pendingUrl || '';
  if (!isRestorableUrl(url)) return null;

  const favIconUrl = typeof tab.favIconUrl === 'string' && tab.favIconUrl.length <= RECENT_FAVICON_MAX
    ? tab.favIconUrl
    : '';

  return {
    url,
    title: String(tab.title || url).slice(0, 300),
    favIconUrl,
  };
}

/**
 * rememberTab(tab)
 * * Keep a session snapshot so a later onRemoved (which has no URL) can still
 *   name the page. Re-reads the tab inside the queue: a close that already
 *   ran will make tabs.get reject, and we must not resurrect that snapshot.
 */
function rememberTab(tab) {
  if (!tab || tab.id == null) return;

  enqueueSession(async () => {
    let fresh = tab;
    try {
      fresh = await chrome.tabs.get(tab.id);
    } catch {
      return;
    }

    const stored = await chrome.storage.session.get(TAB_SNAPSHOTS_KEY);
    const snapshots = stored[TAB_SNAPSHOTS_KEY] || {};
    const key = String(fresh.id);
    const snap = snapshotFromTab(fresh);

    if (!snap) {
      if (!snapshots[key]) return;
      delete snapshots[key];
      await chrome.storage.session.set({ [TAB_SNAPSHOTS_KEY]: snapshots });
      return;
    }

    const prev = snapshots[key];
    if (prev && prev.url === snap.url && prev.title === snap.title && prev.favIconUrl === snap.favIconUrl) {
      return;
    }

    snapshots[key] = snap;
    await chrome.storage.session.set({ [TAB_SNAPSHOTS_KEY]: snapshots });
  });
}

/**
 * recordClosedTab(tabId)
 * * Move the snapshot into the local restore list, then drop it. Same URL
 *   collapses to one row so closing five copies does not become a history.
 */
function recordClosedTab(tabId) {
  enqueueSession(async () => {
    const stored = await chrome.storage.session.get(TAB_SNAPSHOTS_KEY);
    const snapshots = stored[TAB_SNAPSHOTS_KEY] || {};
    const key = String(tabId);
    const snap = snapshots[key];

    if (snap) {
      delete snapshots[key];
      await chrome.storage.session.set({ [TAB_SNAPSHOTS_KEY]: snapshots });
    }

    if (!snap || !isRestorableUrl(snap.url)) return;

    const data = await chrome.storage.local.get(RECENTLY_CLOSED_KEY);
    const next = normalizeRecent([
      { ...snap, closedAt: Date.now() },
      ...(Array.isArray(data[RECENTLY_CLOSED_KEY]) ? data[RECENTLY_CLOSED_KEY] : []),
    ]);
    await chrome.storage.local.set({ [RECENTLY_CLOSED_KEY]: next });
  });
}

/**
 * seedSnapshotsIfEmpty()
 * * Fill the session map once. A full rebuild on every worker start would
 *   race a close: the tab is already gone, the seed would wipe the snapshot,
 *   and the restore list would miss it. Session storage survives worker
 *   restarts, so "only when missing" is the right gate.
 */
function seedSnapshotsIfEmpty() {
  enqueueSession(async () => {
    const stored = await chrome.storage.session.get(TAB_SNAPSHOTS_KEY);
    if (stored[TAB_SNAPSHOTS_KEY]) return;

    const tabs = await chrome.tabs.query({});
    const snapshots = {};
    for (const tab of tabs) {
      const snap = snapshotFromTab(tab);
      if (snap) snapshots[String(tab.id)] = snap;
    }
    await chrome.storage.session.set({ [TAB_SNAPSHOTS_KEY]: snapshots });
  });
}

// ─── Event listeners (registered synchronously) ──────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  scheduleBadgeUpdate();
  seedSnapshotsIfEmpty();
});

chrome.runtime.onStartup.addListener(() => {
  scheduleBadgeUpdate();
  seedSnapshotsIfEmpty();
});

chrome.tabs.onCreated.addListener((tab) => {
  scheduleBadgeUpdate();
  rememberTab(tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  scheduleBadgeUpdate();
  recordClosedTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  scheduleBadgeUpdate();
  const worthRemembering = changeInfo.url || changeInfo.title
    || changeInfo.favIconUrl !== undefined
    || changeInfo.status === 'complete';
  if (worthRemembering) rememberTab(tab);
});

scheduleBadgeUpdate();
seedSnapshotsIfEmpty();
