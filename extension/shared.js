/* ================================================================
   TreeTab — Shared constants

   Loaded by both entry points so their numbers cannot drift apart:
   - index.html includes it before app.js (footer badge tier)
   - background.js pulls it in with importScripts() (toolbar badge colour)

   Classic script, no modules, no side effects, no chrome.* usage.
   ================================================================ */

'use strict';

// ================================================================
// Tab-load tiers
// ================================================================

/**
 * TAB_LOAD_TIERS
 * * Tab counts mapped to a health signal. `label` is the text equivalent of
 *   the colour, so the UI never has to rely on hue alone.
 */
const TAB_LOAD_TIERS = [
  { max: 10, level: 'green', color: '#5a9a7a', label: '还好' },
  { max: 20, level: 'amber', color: '#b8a85e', label: '有点多' },
  { max: Infinity, level: 'red', color: '#b35a5a', label: '该收一收了' },
];

/**
 * tabLoadTier(count)
 * * The tier a tab count falls into — the single source of truth for the
 *   footer badge (class + aria-label) and the toolbar badge (colour).
 */
function tabLoadTier(count) {
  return TAB_LOAD_TIERS.find(tier => count <= tier.max)
    || TAB_LOAD_TIERS[TAB_LOAD_TIERS.length - 1];
}

// ================================================================
// Recently closed — local only
// ================================================================

/** chrome.storage.local list of tabs closed in this browser profile. */
const RECENTLY_CLOSED_KEY = 'treetab-recently-closed';

/** chrome.storage.session map of open tabId → { url, title, favIconUrl }. */
const TAB_SNAPSHOTS_KEY = 'treetab-tab-snapshots';

/** Modest on purpose: this is a restore tray, not a history product. */
const RECENTLY_CLOSED_LIMIT = 12;

/** Drop favicons longer than this so one data-URL cannot crowd out the list. */
const RECENT_FAVICON_MAX = 2048;

/**
 * isInternalPageUrl(url)
 * * Browser and extension pages. Shared so the toolbar badge, the board,
 *   and the restore list agree on what counts as a web tab.
 */
function isInternalPageUrl(url) {
  const value = url || '';
  return (
    value.startsWith('chrome://') ||
    value.startsWith('chrome-extension://') ||
    value.startsWith('chrome-untrusted://') ||
    value.startsWith('about:') ||
    value.startsWith('edge://') ||
    value.startsWith('brave://') ||
    value.startsWith('devtools://') ||
    value.startsWith('view-source:')
  );
}

/**
 * isRestorableUrl(url)
 * * Pages we are willing to reopen ourselves. http(s) and local files only —
 *   no chrome://, no extension pages, no javascript: URLs.
 */
function isRestorableUrl(url) {
  if (!url || isInternalPageUrl(url)) return false;
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:' || protocol === 'file:';
  } catch {
    return false;
  }
}

/**
 * normalizeRecent(list)
 * * The shape both the service worker and the new-tab page trust.
 *   First occurrence of a URL wins, so re-closing a page moves it to the top
 *   instead of filling the tray with copies. Capped at RECENTLY_CLOSED_LIMIT.
 */
function normalizeRecent(list) {
  if (!Array.isArray(list)) return [];

  const seen = new Set();
  const out = [];

  for (const item of list) {
    if (!item || typeof item.url !== 'string' || !isRestorableUrl(item.url)) continue;
    if (seen.has(item.url)) continue;
    seen.add(item.url);

    const title = String(item.title || item.url).slice(0, 300);
    const favIconUrl = typeof item.favIconUrl === 'string' && item.favIconUrl.length <= RECENT_FAVICON_MAX
      ? item.favIconUrl
      : '';

    out.push({
      url: item.url,
      title,
      favIconUrl,
      closedAt: Number(item.closedAt) || 0,
    });

    if (out.length >= RECENTLY_CLOSED_LIMIT) break;
  }

  return out;
}
