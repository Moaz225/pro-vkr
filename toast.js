/* Simple toast notifications (Phase 1).
 * Usage: showToast('Сообщение', 'success'|'error'|'warning'|'info', 3000)
 */

(function () {
  const MAX_VISIBLE = 3;
  const DEFAULT_DURATION = 3000;
  const CONTAINER_ID = 'brodskyToastContainer';

  function ensureContainer() {
    let el = document.getElementById(CONTAINER_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = CONTAINER_ID;
    el.className = 'brodsky-toast-container';
    document.body.appendChild(el);
    return el;
  }

  function normalizeType(type) {
    const t = String(type || 'info').toLowerCase();
    if (t === 'success' || t === 'error' || t === 'warning' || t === 'info') return t;
    return 'info';
  }

  window.showToast = function showToast(message, type = 'info', duration = DEFAULT_DURATION) {
    const container = ensureContainer();
    const toast = document.createElement('div');
    const toastType = normalizeType(type);
    toast.className = `brodsky-toast brodsky-toast--${toastType}`;
    toast.setAttribute('role', toastType === 'error' ? 'alert' : 'status');
    toast.setAttribute('aria-live', toastType === 'error' ? 'assertive' : 'polite');

    const text = document.createElement('div');
    text.className = 'brodsky-toast__text';
    text.textContent = String(message || '');

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'brodsky-toast__close';
    close.setAttribute('aria-label', 'Закрыть уведомление');
    close.textContent = '×';

    toast.appendChild(text);
    toast.appendChild(close);

    const dismiss = () => {
      if (toast.dataset.dismissed) return;
      toast.dataset.dismissed = '1';
      toast.classList.add('is-hiding');
      window.setTimeout(() => toast.remove(), 220);
    };

    close.addEventListener('click', dismiss);

    // stack limit
    const toasts = Array.from(container.querySelectorAll('.brodsky-toast'));
    if (toasts.length >= MAX_VISIBLE) {
      toasts.slice(0, toasts.length - (MAX_VISIBLE - 1)).forEach((t) => t.remove());
    }

    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('is-visible'));

    const ms = Number(duration);
    if (Number.isFinite(ms) && ms > 0) window.setTimeout(dismiss, ms);
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { showToast: window.showToast };
  }
})();
