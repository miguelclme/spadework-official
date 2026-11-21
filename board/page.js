'use strict';

// What the board's page (app.js) and init's config panel (config.js) share:
// the theme, the key from the link, short messages, and building elements
// with textContent only, so nothing is ever parsed as markup.
window.SpadeworkPage = (function () {
  // Dark or light: the user's choice, kept in this browser, or the system setting.
  const THEME_KEY = 'spadework-theme';
  const savedTheme = () => { try { return localStorage.getItem(THEME_KEY); } catch { return null; } };
  const systemTheme = () => (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = ['light', 'dark'].includes(savedTheme()) ? savedTheme() : systemTheme();

  function h(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  const clear = (node) => { node.textContent = ''; return node; };

  // The key from the page's link, kept for this tab and taken out of the address bar.
  function readKey() {
    const fromUrl = new URLSearchParams(location.search).get('key');
    let key;
    try {
      if (fromUrl) sessionStorage.setItem('spadework-key', fromUrl);
      key = fromUrl || sessionStorage.getItem('spadework-key');
    } catch {
      key = fromUrl;
    }
    if (fromUrl) history.replaceState(null, '', location.pathname);
    return key;
  }

  // The theme button: it names the other theme, switches to it and keeps the choice.
  function themeButton(button, onChange) {
    const paint = () => {
      const light = document.documentElement.dataset.theme === 'light';
      button.textContent = light ? '☾ Dark' : '☀ Light';
      button.setAttribute('aria-label', light ? 'Switch to the dark theme' : 'Switch to the light theme');
    };
    paint();
    button.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem(THEME_KEY, next); } catch { /* not saved */ }
      paint();
      if (onChange) onChange();
    });
  }

  // A short message at the bottom of the page: errors stay longer.
  let toastTimer = null;
  function toast(box, text, bad) {
    box.textContent = text;
    box.className = `toast on${bad ? ' bad' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.className = 'toast'; }, bad ? 6000 : 2600);
  }

  return Object.freeze({ h, clear, readKey, themeButton, toast });
})();
