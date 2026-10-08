/**
 * Social-proof purchase toasts — top of screen, ~50s, random flags.
 */
(function (global) {
  var ENABLED = true;
  var FIRST_MIN_MS = 8 * 1000;
  var FIRST_MAX_MS = 18 * 1000;
  var INTERVAL_MIN_MS = 38 * 1000;
  var INTERVAL_MAX_MS = 62 * 1000;
  var VISIBLE_MS = 7000;
  var scheduleTimer = null;
  var hideTimer = null;
  var videoPool = [];

  var METHODS = [
    'Paid with PayPal',
    'Paid with card',
    'Paid with Cash App',
    'Paid with Apple Pay'
  ];

  /** Europe, USA and other non-Africa locales. */
  var LOCALES = [
    { flag: '🇺🇸', label: 'United States', weight: 6 },
    { flag: '🇬🇧', label: 'United Kingdom', weight: 4 },
    { flag: '🇩🇪', label: 'Germany', weight: 3 },
    { flag: '🇫🇷', label: 'France', weight: 3 },
    { flag: '🇳🇱', label: 'Netherlands', weight: 2 },
    { flag: '🇪🇸', label: 'Spain', weight: 2 },
    { flag: '🇮🇹', label: 'Italy', weight: 2 },
    { flag: '🇵🇹', label: 'Portugal', weight: 2 },
    { flag: '🇸🇪', label: 'Sweden', weight: 1 },
    { flag: '🇳🇴', label: 'Norway', weight: 1 },
    { flag: '🇩🇰', label: 'Denmark', weight: 1 },
    { flag: '🇧🇪', label: 'Belgium', weight: 1 },
    { flag: '🇨🇭', label: 'Switzerland', weight: 1 },
    { flag: '🇦🇹', label: 'Austria', weight: 1 },
    { flag: '🇵🇱', label: 'Poland', weight: 1 },
    { flag: '🇮🇪', label: 'Ireland', weight: 1 },
    { flag: '🇨🇦', label: 'Canada', weight: 3 },
    { flag: '🇦🇺', label: 'Australia', weight: 2 },
    { flag: '🇳🇿', label: 'New Zealand', weight: 1 },
    { flag: '🇧🇷', label: 'Brazil', weight: 2 },
    { flag: '🇯🇵', label: 'Japan', weight: 1 },
    { flag: '🇰🇷', label: 'South Korea', weight: 1 }
  ];

  var LOCALE_BAG = [];
  LOCALES.forEach(function (loc) {
    for (var i = 0; i < loc.weight; i++) LOCALE_BAG.push(loc);
  });

  var PROMO = { title: 'All Content', price: 150 };

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;');
  }

  function randInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  function pick(arr) {
    if (!arr.length) return null;
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function paidProducts() {
    return videoPool.filter(function (v) {
      return v && !v.is_free && Number(v.price) > 0 && String(v.title || '').trim();
    });
  }

  function nextNotice() {
    var locale = pick(LOCALE_BAG) || LOCALES[0];
    var method = pick(METHODS);
    var who = locale.flag + ' Someone in ' + locale.label;
    var pool = paidProducts();
    if (pool.length && Math.random() < 0.45) {
      var v = pick(pool);
      return {
        flag: locale.flag,
        who: who,
        method: method,
        title: String(v.title || PROMO.title).trim(),
        price: Number(v.price) || PROMO.price
      };
    }
    return {
      flag: locale.flag,
      who: who,
      method: method,
      title: PROMO.title,
      price: PROMO.price
    };
  }

  function injectStyles() {
    if (document.getElementById('purchase-toast-styles')) return;
    var style = document.createElement('style');
    style.id = 'purchase-toast-styles';
    style.textContent =
      '.purchase-toast{' +
      'position:fixed;left:50%;top:0.85rem;z-index:2147483000;' +
      'width:min(400px,calc(100vw - 1.5rem));display:flex;align-items:flex-start;gap:0.7rem;' +
      'padding:0.9rem 1rem;border-radius:12px;background:rgba(21,21,24,0.96);' +
      'border:1px solid rgba(255,255,255,0.14);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);' +
      'box-shadow:0 12px 40px rgba(0,0,0,0.55);' +
      'transform:translate(-50%,-120%);opacity:0;' +
      'transition:transform .45s cubic-bezier(.22,1,.36,1),opacity .45s cubic-bezier(.22,1,.36,1);' +
      'pointer-events:none;visibility:hidden}' +
      '.purchase-toast.show{transform:translate(-50%,0);opacity:1;visibility:visible}' +
      '.purchase-toast.hide{transform:translate(-50%,-20%);opacity:0;visibility:visible}' +
      '.purchase-toast-flag{' +
      'flex-shrink:0;width:2rem;height:2rem;border-radius:50%;' +
      'display:flex;align-items:center;justify-content:center;' +
      'font-size:1.35rem;line-height:1;background:rgba(255,255,255,0.08);' +
      'border:1px solid rgba(255,255,255,0.12);margin-top:0.05rem}' +
      '.purchase-toast-body{flex:1;min-width:0;font-size:.78rem;line-height:1.45;color:#a1a1aa}' +
      '.purchase-toast-who{display:block;font-weight:700;color:#f5f5f7;margin-bottom:.12rem}' +
      '.purchase-toast-msg em{font-style:normal;color:#ff2d55;font-weight:700}' +
      '.purchase-toast-time{flex-shrink:0;font-size:.62rem;font-weight:700;color:#71717a;text-transform:uppercase;letter-spacing:.05em;padding-top:.15rem}' +
      '@media (max-width:480px){.purchase-toast{top:.55rem;width:calc(100vw - 1rem)}}';
    document.head.appendChild(style);
  }

  function ensureDom() {
    injectStyles();
    var el = document.getElementById('purchase-toast');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'purchase-toast';
    el.className = 'purchase-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.innerHTML =
      '<span class="purchase-toast-flag" aria-hidden="true"></span>' +
      '<div class="purchase-toast-body">' +
      '<strong class="purchase-toast-who"></strong>' +
      '<span class="purchase-toast-msg"></span>' +
      '</div>' +
      '<span class="purchase-toast-time">just now</span>';
    document.body.appendChild(el);
    return el;
  }

  function showToast() {
    if (!ENABLED) return;
    var notice = nextNotice();
    if (!notice) return;
    var el = ensureDom();
    el.querySelector('.purchase-toast-flag').textContent = notice.flag || '🇺🇸';
    el.querySelector('.purchase-toast-who').textContent = notice.who;
    el.querySelector('.purchase-toast-msg').innerHTML =
      escapeHtml(notice.method) + ' · <span>' + escapeHtml(notice.title) +
      '</span> · <em>$' + Number(notice.price).toFixed(2) + '</em>';
    el.querySelector('.purchase-toast-time').textContent = 'just now';
    el.classList.remove('hide', 'show');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      el.classList.add('hide');
      el.classList.remove('show');
      setTimeout(function () {
        el.classList.remove('hide');
      }, 450);
    }, VISIBLE_MS);
  }

  function scheduleNext(isFirst) {
    if (!ENABLED) return;
    clearTimeout(scheduleTimer);
    var delay = isFirst
      ? randInt(FIRST_MIN_MS, FIRST_MAX_MS)
      : randInt(INTERVAL_MIN_MS, INTERVAL_MAX_MS);
    scheduleTimer = setTimeout(function () {
      showToast();
      scheduleNext(false);
    }, delay);
  }

  function stop() {
    clearTimeout(scheduleTimer);
    clearTimeout(hideTimer);
    scheduleTimer = null;
    hideTimer = null;
  }

  function setVideos(videos) {
    videoPool = Array.isArray(videos) ? videos : [];
  }

  function start(opts) {
    stop();
    if (opts && Array.isArray(opts.videos)) setVideos(opts.videos);
    ensureDom();
    scheduleNext(true);
  }

  global.PurchaseToasts = {
    start: start,
    stop: stop,
    setVideos: setVideos
  };
})(typeof window !== 'undefined' ? window : this);
