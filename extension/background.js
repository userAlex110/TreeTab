/**
 * background.js — Service Worker for Badge Updates
 *
 * Chrome's "always-on" background script for TreeTab.
 * Its only job: keep the toolbar badge showing the current open tab count.
 *
 * Since we no longer have a server, we query chrome.tabs directly.
 * The badge counts real web tabs (skipping chrome:// and extension pages).
 *
 * Color coding gives a quick at-a-glance health signal:
 *   Green  (#5a9a7a) → 1–10 tabs  (focused, manageable)
 *   Amber  (#b8a85e) → 11–20 tabs (getting busy)
 *   Red    (#b35a5a) → 21+ tabs   (time to cull!)
 */

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

    // Pick badge color based on workload level
    let color;
    if (count <= 10) {
      color = '#5a9a7a'; // Green — you're in control
    } else if (count <= 20) {
      color = '#b8a85e'; // Amber — things are piling up
    } else {
      color = '#b35a5a'; // Red — time to focus and close some tabs
    }

    await chrome.action.setBadgeBackgroundColor({ color });

  } catch {
    // If something goes wrong, clear the badge rather than show stale data
    chrome.action.setBadgeText({ text: '' });
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────

// A page load fires many onUpdated events in a row; coalesce them so the
// service worker queries tabs once per burst instead of once per event.
const BADGE_DEBOUNCE_MS = 300;
let badgeTimer = null;

/**
 * scheduleBadgeUpdate()
 *
 * Debounced updateBadge() — the badge only needs to show the count once a
 * burst of tab events has settled.
 */
function scheduleBadgeUpdate() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(updateBadge, BADGE_DEBOUNCE_MS);
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

// Run once immediately when the service worker first loads
updateBadge();
