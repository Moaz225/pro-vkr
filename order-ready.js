/**
 * Уведомления «заказ готов» для клиентов (роль user): SSE + fallback-опрос.
 */
(function (w) {
  const PROMPT_KEY = 'brodsky_notif_prompt_asked';
  var es = null;
  var pollTimer = null;
  var seenDone = new Set();
  var pollInitialized = false;
  var currentApiBase = '';

  function normalizeBase(apiBase) {
    if (apiBase) return String(apiBase).replace(/\/+$/, '');
    if (!w.location || !(w.location.protocol === 'http:' || w.location.protocol === 'https:')) return '';
    return w.location.origin;
  }

  /** Первый визит: запрос права уведомлений (Firefox/Chrome покажут браузерный диалог). */
  function promptOnceGlobal() {
    try {
      if (w.localStorage.getItem(PROMPT_KEY)) return;
      w.localStorage.setItem(PROMPT_KEY, '1');
    } catch (_) {
      return;
    }
    if (!w.Notification || w.Notification.permission !== 'default') return;
    try {
      w.Notification.requestPermission().catch(function () {});
    } catch (_) {}
  }

  function playBell() {
    try {
      var AC = w.AudioContext || w.webkitAudioContext;
      if (!AC) return;
      var ctx = new AC();
      if (ctx.state === 'suspended') ctx.resume().catch(function () {});
      var osc = ctx.createOscillator();
      var gn = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      gn.gain.setValueAtTime(0.0001, ctx.currentTime);
      gn.gain.linearRampToValueAtTime(0.12, ctx.currentTime + 0.02);
      gn.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
      osc.connect(gn);
      gn.connect(ctx.destination);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.28);
    } catch (_) {}
  }

  function showAlerts(orderId, repeat) {
    var msg = repeat ? 'Ваш заказ готов! (напоминание)' : 'Ваш заказ готов!';
    var shortId = orderId.length > 28 ? orderId.slice(0, 24) + '…' : orderId;
    var body = 'Номер заказа: ' + shortId;

    try {
      if (typeof w.showToast === 'function') w.showToast(msg + ' · ' + body, 'success', 7000);
    } catch (_) {}
    playBell();

    try {
      if (w.Notification && w.Notification.permission === 'granted') {
        var tag = repeat ? 'brodsky-ready-r-' + String(orderId) + '-' + Date.now() : 'brodsky-ready-' + String(orderId);
        new w.Notification(msg, { body: body, tag: tag, silent: false });
      }
    } catch (_) {}
  }

  function consumeSsePayload(data) {
    if (!data || data.type !== 'order_ready') return;
    var id = String(data.orderId || '');
    if (!id) return;

    var repeat = !!data.repeat;
    if (repeat) {
      seenDone.add(id);
      showAlerts(id, true);
      return;
    }
    if (seenDone.has(id)) return;
    seenDone.add(id);
    showAlerts(id, false);
  }

  async function ingestOrdersPoll(rows) {
    var doneIds = (rows || [])
      .filter(function (o) {
        return o && String(o.status) === 'done';
      })
      .map(function (o) {
        return String(o.orderId || '');
      })
      .filter(Boolean);

    if (!pollInitialized) {
      doneIds.forEach(function (id) {
        seenDone.add(id);
      });
      pollInitialized = true;
      return;
    }

    for (var i = 0; i < doneIds.length; i++) {
      var id = doneIds[i];
      if (seenDone.has(id)) continue;
      seenDone.add(id);
      showAlerts(id, false);
    }
  }

  async function pollOrders() {
    var base = currentApiBase || normalizeBase();
    if (!base) return;
    try {
      var res = await w.fetch(base + '/api/me/orders', {
        credentials: 'include',
        cache: 'no-store'
      });
      var data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok || !data.orders) return;
      await ingestOrdersPoll(data.orders);
    } catch (_) {}
  }

  function startEventSource(apiBase) {
    if (typeof w.EventSource === 'undefined') return;
    var origin = normalizeBase(apiBase);
    if (!origin) return;
    try {
      if (es) {
        es.close();
        es = null;
      }
    } catch (_) {}
    try {
      es = new w.EventSource(origin + '/api/me/order-ready-events');
    } catch (_) {
      es = null;
      return;
    }
    es.onmessage = function (ev) {
      try {
        consumeSsePayload(JSON.parse(ev.data));
      } catch (_) {}
    };
    es.onerror = function () {};
  }

  async function bootstrap(apiBaseOpt) {
    currentApiBase = normalizeBase(apiBaseOpt);
    var base = currentApiBase;
    if (!base) return;

    promptOnceGlobal();

    try {
      var res = await w.fetch(base + '/api/auth/me', { credentials: 'include', cache: 'no-store' });
      var data = await res.json().catch(function () {
        return {};
      });

      try {
        if (res.ok && data.user && String(data.user.role) === 'user' && w.Notification) {
          if (w.Notification.permission === 'default') {
            await w.Notification.requestPermission().catch(function () {});
          }
        }
      } catch (_) {}

      var roleCustomer = !!(res.ok && data.user && String(data.user.role) === 'user');

      pollInitialized = false;
      seenDone = new Set();

      await pollOrders();
      if (pollTimer) w.clearInterval(pollTimer);

      if (roleCustomer) {
        pollTimer = w.setInterval(pollOrders, 25000);
        startEventSource(base);
      }
    } catch (_) {}
  }

  w.brodskyBootstrapOrderReady = bootstrap;
})(typeof window !== 'undefined' ? window : globalThis);
