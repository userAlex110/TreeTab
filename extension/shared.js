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
  { max: 10, level: 'green', color: '#5a9a7a', label: 'manageable' },
  { max: 20, level: 'amber', color: '#b8a85e', label: 'getting busy' },
  { max: Infinity, level: 'red', color: '#b35a5a', label: 'time to cull' },
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
