/**
 * main.js — Application Entry Point
 *
 * Boots the app:
 *   1. Load persisted data
 *   2. Apply profile settings to UI
 *   3. Render profile tabs and the tile grid
 *   4. Register all event listeners
 */

import { load }                        from './storage.js';
import { applyProfileSettings, renderProfileTabs, renderGrid, syncThemeIcon, renderLucideIcons } from './ui.js';
import { registerEvents }              from './events.js';

function init() {
  if (!document.documentElement.hasAttribute('data-theme')) {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  }
  syncThemeIcon();
  load();
  applyProfileSettings();
  renderProfileTabs();
  renderGrid();
  registerEvents();
  // Render all Lucide icons in the static HTML (theme toggle, grid controls)
  renderLucideIcons();
}

// Run after DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
