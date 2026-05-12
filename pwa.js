/* Shared PWA client helper:
 * - Register service worker
 * - Show offline banner
 */

(function () {
  const BANNER_ID = 'brodskyOfflineBanner';

  function ensureBanner() {
    let el = document.getElementById(BANNER_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = BANNER_ID;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.textContent = 'Офлайн-режим: часть данных может быть устаревшей';
    el.style.position = 'fixed';
    el.style.top = '0';
    el.style.left = '0';
    el.style.right = '0';
    el.style.zIndex = '4000';
    el.style.padding = '10px 14px';
    el.style.background = '#111';
    el.style.color = '#fff';
    el.style.fontSize = '0.9rem';
    el.style.textAlign = 'center';
    el.style.boxShadow = '0 6px 18px rgba(0,0,0,.18)';
    el.style.transform = 'translateY(-120%)';
    el.style.transition = 'transform 200ms ease';
    document.body.appendChild(el);
    return el;
  }

  function setOfflineUI(isOffline) {
    const banner = ensureBanner();
    banner.style.transform = isOffline ? 'translateY(0)' : 'translateY(-120%)';
  }

  window.addEventListener('online', () => setOfflineUI(false));
  window.addEventListener('offline', () => setOfflineUI(true));
  setOfflineUI(!navigator.onLine);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }
})();

