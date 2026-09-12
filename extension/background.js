/**
 * background.js — Service Worker for Badge Updates
 *
 * Chrome's "always-on" background script for TreeTab.
 * Its only job: keep the toolbar badge showing the current open tab count.
 *
 * Since we no longer have a server, we query chrome.tabs directly.
 * The badge counts real web tabs (skipping chrome:// and extension pages).
 *
 * The colour coding comes from TAB_LOAD_TIERS in shared.js, which the new tab
 * page's footer badge reads as well — one tier table, two badges.
 */

// Shared tier table (classic worker: importScripts is available at the top level)
importScripts('shared.js');

// ─── Badge updater ────────────────────────────────────────────────────────────

/**
 * updateBadge()
 *
 * Counts open real-web tabs and updates the extension's toolbar badge.
 * "Real" tabs = not chrome://, not extension pages, not about:blank.
 */
async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});

    // Only count actual web pages — skip browser internals and extension pages
    const count = tabs.filter(t => {
      const url = t.url || '';
      return (
        !url.startsWith('chrome://') &&
        !url.startsWith('chrome-extension://') &&
        !url.startsWith('about:') &&
        !url.startsWith('edge://') &&
        !url.startsWith('brave://')
      );
    }).length;

    // Don't show "0" — an empty badge is cleaner
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });

    if (count === 0) return;

    // Workload colour comes from the shared tier table
    await chrome.action.setBadgeBackgroundColor({ color: tabLoadTier(count).color });

  } catch {
    // If something goes wrong, clear the badge rather than show stale data
    try {
      await chrome.action.setBadgeText({ text: '' });
    } catch { /* the toolbar is unreachable; nothing left to update */ }
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────

/**
 * scheduleBadgeUpdate()
 *
 * Coalesces a burst of tab events into one updateBadge() run.
 *
 * A page load fires many onUpdated events in a row, and a service worker is
 * torn down after ~30s idle — so this chains onto the previous run instead of
 * holding a setTimeout handle in a global. The flag is self-healing: it only
 * needs to live as long as the burst, and the next event re-arms it.
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

// Update badge when the extension is first installed
chrome.runtime.onInstalled.addListener(scheduleBadgeUpdate);

// Update badge when Chrome starts up
chrome.runtime.onStartup.addListener(scheduleBadgeUpdate);

// Update badge whenever a tab is opened
chrome.tabs.onCreated.addListener(scheduleBadgeUpdate);

// Update badge whenever a tab is closed
chrome.tabs.onRemoved.addListener(scheduleBadgeUpdate);

// Update badge when a tab's URL changes (e.g. navigating to/from chrome://)
chrome.tabs.onUpdated.addListener(scheduleBadgeUpdate);

// ─── Initial run ─────────────────────────────────────────────────────────────

// Run once when the service worker first loads
scheduleBadgeUpdate();
