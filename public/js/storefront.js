(function (global) {
  var MASKED_PRODUCT_NAME = 'Digital Ebook';

  function normalizeOrigin(u) {
    try { return new URL(u).origin; } catch (e) { return ''; }
  }

  function pickMaskedName(custom) {
    if (custom && String(custom).trim()) return String(custom).trim();
    return MASKED_PRODUCT_NAME;
  }

  function ebooksSuccessUrl(ebooksOrigin, price, maskedName, displayTitle, videoId) {
    var origin = normalizeOrigin(String(ebooksOrigin || '').replace(/\/+$/, ''));
    if (!origin) return null;
    var p = new URLSearchParams();
    p.set('status', 'success');
    p.set('product_name', pickMaskedName(maskedName));
    if (displayTitle) p.set('display_title', String(displayTitle));
    p.set('amount', String(price));
    if (videoId) p.set('video_id', String(videoId));
    return origin + '/?' + p.toString();
  }

  function checkoutMethodForOrigin(ebooksOrigin, localCheckout) {
    if (localCheckout) return 'payjsr';
    var origin = normalizeOrigin(String(ebooksOrigin || '').trim().replace(/\/+$/, ''));
    return origin ? 'whop' : 'payjsr';
  }

  function checkoutApiPath(ebooksOrigin, localCheckout) {
    if (localCheckout) return '/api/payjsr-checkout';
    var origin = normalizeOrigin(String(ebooksOrigin || '').trim().replace(/\/+$/, ''));
    return origin ? '/api/paypal-checkout' : '/api/payjsr-checkout';
  }

  function checkoutQuery(ebooksOrigin, price, maskedName, displayTitle, videoId, method, extra, localCheckout) {
    var origin = normalizeOrigin(String(ebooksOrigin || '').trim().replace(/\/+$/, ''));
    if (localCheckout) origin = typeof window !== 'undefined' ? window.location.origin : origin;
    if (!origin) return null;
    var vid = videoId || '';
    var title = displayTitle || 'Digital purchase';
    var masked = pickMaskedName(maskedName);
    var successUrl = ebooksSuccessUrl(origin, price, masked, title, vid);
    if (!successUrl) return null;
    var p = new URLSearchParams();
    p.set('amount', String(price));
    p.set('currency', 'USD');
    p.set('success_url', successUrl);
    p.set('product_name', masked);
    p.set('display_title', title);
    p.set('method', method || checkoutMethodForOrigin(origin, localCheckout));
    if (vid) p.set('video_id', vid);
    if (extra) {
      Object.keys(extra).forEach(function (k) {
        if (extra[k] != null && extra[k] !== '') p.set(k, String(extra[k]));
      });
    }
    return p;
  }

  function checkoutCancelUrl(origin, checkoutParams, apiPath) {
    var cancelP = new URLSearchParams(checkoutParams.toString());
    cancelP.set('payment_canceled', 'true');
    return origin + (apiPath || '/api/payjsr-checkout') + '?' + cancelP.toString();
  }

  function checkoutUrl(ebooksOrigin, price, maskedName, displayTitle, videoId, method, localCheckout) {
    var origin = normalizeOrigin(String(ebooksOrigin || '').trim().replace(/\/+$/, ''));
    if (localCheckout && typeof window !== 'undefined') origin = window.location.origin;
    var apiPath = checkoutApiPath(ebooksOrigin, localCheckout);
    var p = checkoutQuery(ebooksOrigin, price, maskedName, displayTitle, videoId, method, null, localCheckout);
    if (!p || !origin) return null;
    p.set('cancel_url', checkoutCancelUrl(origin, p, apiPath));
    return origin + apiPath + '?' + p.toString();
  }

  function watchUrl(videoId, preview) {
    var u = '/watch?id=' + encodeURIComponent(videoId || '');
    if (preview) u += '&preview=1';
    return u;
  }

  function formatDuration(d) {
    if (d == null || d === '') return '';
    if (typeof d === 'number' && !isNaN(d)) {
      var sec = Math.max(0, Math.round(Number(d)));
      var m = Math.floor(sec / 60), s = sec % 60;
      return m + 'min ' + s + 's';
    }
    var parts = String(d).split(':');
    if (parts.length === 2) {
      var mm = parseInt(parts[0], 10) || 0, ss = Math.round(parseFloat(parts[1]) || 0);
      return mm + 'min ' + ss + 's';
    }
    if (parts.length === 3) {
      var h = parseInt(parts[0], 10) || 0, mm2 = parseInt(parts[1], 10) || 0, ss2 = Math.round(parseFloat(parts[2]) || 0);
      return h + 'h ' + mm2 + 'm ' + ss2 + 's';
    }
    return String(d);
  }

  function formatViews(v) {
    v = Number(v) || 0;
    if (v < 1000) return v + ' views';
    if (v < 1e6) return (v / 1000).toFixed(1) + 'K views';
    return (v / 1e6).toFixed(1) + 'M views';
  }

  function formatDateRel(iso) {
    if (!iso) return '';
    var date = new Date(iso);
    if (isNaN(date.getTime())) return '';
    var ms = Date.now() - date.getTime();
    if (ms < 0) ms = 0;
    var sec = Math.floor(ms / 1000);
    var min = Math.floor(sec / 60);
    var hr = Math.floor(min / 60);
    var days = Math.floor(hr / 24);
    if (sec < 60) return 'Just now';
    if (min < 60) return min === 1 ? '1 minute ago' : min + ' minutes ago';
    if (hr < 24) return hr === 1 ? '1 hour ago' : hr + ' hours ago';
    if (days === 1) return 'Yesterday';
    if (days < 7) return days + ' days ago';
    if (days < 30) {
      var weeks = Math.floor(days / 7);
      return weeks === 1 ? '1 week ago' : weeks + ' weeks ago';
    }
    if (days < 365) {
      var months = Math.floor(days / 30);
      return months === 1 ? '1 month ago' : months + ' months ago';
    }
    var years = Math.floor(days / 365);
    return years === 1 ? '1 year ago' : years + ' years ago';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  }

  function escapeAttr(s) { return escapeHtml(s).replace(/'/g, '&#39;'); }

  var DEFAULT_POSTER_AT = 1;
  var POSTER_CONCURRENCY = 2;
  var POSTER_TIMEOUT_MS = 12000;
  var signedUrlCache = {};
  var posterImageCache = {};
  var posterJobs = [];
  var posterActive = 0;
  var posterPending = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  var posterObserver = null;
  var posterScrollBound = false;

  async function fetchSigned(fileKey) {
    if (!fileKey) return null;
    var cacheKey = String(fileKey).trim();
    if (signedUrlCache[cacheKey]) return signedUrlCache[cacheKey];
    var r = await fetch('/api/signed-url?key=' + encodeURIComponent(cacheKey));
    if (!r.ok) return null;
    var j = await r.json();
    var url = j.success && j.url ? j.url : null;
    if (url) signedUrlCache[cacheKey] = url;
    return url;
  }

  function posterAtSeconds(v) {
    var n = Number(v && v.poster_at);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_POSTER_AT;
  }

  function posterCacheKey(v, atSec) {
    var id = v && v.id != null ? String(v.id) : '';
    var at = atSec != null ? atSec : posterAtSeconds(v);
    return id + '@' + at;
  }

  function readSessionPoster(key) {
    try {
      return sessionStorage.getItem('vposter:' + key);
    } catch (e) {
      return null;
    }
  }

  function writeSessionPoster(key, dataUrl) {
    if (!key || !dataUrl || dataUrl.length > 180000) return;
    try {
      sessionStorage.setItem('vposter:' + key, dataUrl);
    } catch (e) { /* quota */ }
  }

  function unloadVideoEl(video) {
    if (!video) return;
    try { video.pause(); } catch (e) { /* ignore */ }
    video.removeAttribute('src');
    video.src = '';
    video.removeAttribute('poster');
    try { video.load(); } catch (e2) { /* ignore */ }
  }

  function capturePosterDataUrl(video) {
    if (!video || !video.videoWidth || !video.videoHeight) return null;
    try {
      var maxW = 480;
      var w = video.videoWidth;
      var h = video.videoHeight;
      if (w > maxW) {
        h = Math.round(h * (maxW / w));
        w = maxW;
      }
      var canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, w, h);
      return canvas.toDataURL('image/jpeg', 0.72);
    } catch (e) {
      return null;
    }
  }

  function showPosterImage(container, src) {
    if (!container || !src) return null;
    var video = container.querySelector('video');
    var img = container.querySelector('img.js-poster');
    if (!img) {
      img = document.createElement('img');
      img.className = 'js-poster';
      img.alt = '';
      img.decoding = 'async';
      img.setAttribute('aria-hidden', 'true');
      if (video && video.parentNode === container) container.insertBefore(img, video);
      else container.insertBefore(img, container.firstChild);
    }
    img.loading = 'eager';
    img.src = src;
    img.style.display = 'block';
    if (video) {
      video.style.display = 'none';
      unloadVideoEl(video);
    }
    return img;
  }

  function posterPriority(el) {
    if (!el || !el.getBoundingClientRect) return 1e9;
    var r = el.getBoundingClientRect();
    var vh = window.innerHeight || 800;
    if (r.bottom < -40) return 500000 + Math.round(r.top);
    if (r.top < vh + 80) return Math.round(r.top);
    return 100000 + Math.round(r.top);
  }

  function sortPosterJobs() {
    posterJobs.forEach(function (job) {
      job.priority = posterPriority(job.container);
    });
    posterJobs.sort(function (a, b) { return a.priority - b.priority; });
  }

  function bindPosterScroll() {
    if (posterScrollBound) return;
    posterScrollBound = true;
    var ticking = false;
    function onMove() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        if (posterJobs.length) sortPosterJobs();
      });
    }
    window.addEventListener('scroll', onMove, { passive: true });
    window.addEventListener('resize', onMove, { passive: true });
  }

  function ensurePosterObserver() {
    if (posterObserver) return posterObserver;
    if (typeof IntersectionObserver === 'undefined') return null;
    posterObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var rec = posterPending ? posterPending.get(entry.target) : null;
        if (!rec) {
          posterObserver.unobserve(entry.target);
          return;
        }
        if (posterPending) posterPending.delete(entry.target);
        posterObserver.unobserve(entry.target);
        enqueuePosterJob(rec, false);
      });
      pumpPosterQueue();
    }, { root: null, rootMargin: '160px 0px 720px 0px', threshold: 0.01 });
    return posterObserver;
  }

  function enqueuePosterJob(rec, autoPump) {
    if (!rec || !rec.container || !rec.container.isConnected) return;
    var exists = posterJobs.some(function (j) { return j.container === rec.container; });
    if (exists) return;
    rec.priority = posterPriority(rec.container);
    posterJobs.push(rec);
    bindPosterScroll();
    if (autoPump !== false) pumpPosterQueue();
  }

  function pumpPosterQueue() {
    sortPosterJobs();
    while (posterActive < POSTER_CONCURRENCY && posterJobs.length) {
      var job = posterJobs.shift();
      posterActive += 1;
      runPosterJob(job).then(function () {
        posterActive -= 1;
        pumpPosterQueue();
      }, function () {
        posterActive -= 1;
        pumpPosterQueue();
      });
    }
  }

  async function runPosterJob(job) {
    var container = job.container;
    var v = job.v;
    var opts = job.opts || {};
    if (!container || !container.isConnected || !v) return null;
    var at = opts.at != null ? opts.at : posterAtSeconds(v);
    var key = posterCacheKey(v, at);
    var cached = posterImageCache[key] || readSessionPoster(key);
    if (cached) {
      posterImageCache[key] = cached;
      var img = showPosterImage(container, cached);
      if (opts.onReady) opts.onReady(img);
      return img;
    }
    var url = opts.url || (await resolvePlaybackUrl(v));
    if (!url || !container.isConnected) {
      if (opts.onError) opts.onError(new Error('missing'));
      return null;
    }
    try {
      var el = await applyVideoPoster(container, url, at);
      var shown = container.querySelector('img.js-poster') || el;
      var data = shown && shown.tagName === 'IMG' ? shown.src : null;
      if (data && data.indexOf('data:image') === 0) {
        posterImageCache[key] = data;
        writeSessionPoster(key, data);
      }
      if (opts.onReady) opts.onReady(shown);
      return shown;
    } catch (e) {
      if (opts.onError) opts.onError(e);
      return null;
    }
  }

  function applyVideoPoster(container, url, atSec) {
    return new Promise(function (resolve, reject) {
      if (!container || !url) {
        reject(new Error('missing'));
        return;
      }
      var video = container.querySelector('video');
      if (!video) {
        video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.setAttribute('playsinline', '');
        video.setAttribute('muted', '');
        video.setAttribute('aria-hidden', 'true');
        container.appendChild(video);
      }
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      var settled = false;
      var timer = setTimeout(function () { finish(false); }, POSTER_TIMEOUT_MS);
      function finish(ok) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ok) {
          var data = capturePosterDataUrl(video);
          if (data) {
            var img = showPosterImage(container, data);
            resolve(img || video);
            return;
          }
          video.style.display = 'block';
          resolve(video);
        } else {
          unloadVideoEl(video);
          reject(new Error('poster'));
        }
      }
      video.onerror = function () { finish(false); };
      video.onseeked = function () {
        try { video.pause(); } catch (e) { /* ignore */ }
        finish(true);
      };
      video.onloadedmetadata = function () {
        var dur = video.duration;
        var t = Number(atSec);
        if (!Number.isFinite(t) || t < 0) t = DEFAULT_POSTER_AT;
        if (Number.isFinite(dur) && dur > 0) {
          t = Math.min(t, Math.max(0, dur - 0.05));
        }
        try {
          video.currentTime = t;
        } catch (e) {
          finish(false);
        }
      };
      var startAt = Number(atSec);
      if (!Number.isFinite(startAt) || startAt < 0) startAt = DEFAULT_POSTER_AT;
      var src = url;
      if (src.indexOf('#') < 0) src += '#t=' + startAt;
      video.src = src;
      video.load();
    });
  }

  function resetPosterHydration() {
    posterJobs = [];
    if (posterObserver) {
      posterObserver.disconnect();
      posterObserver = null;
    }
    posterPending = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  }

  async function hydrateVideoPoster(v, container, opts) {
    opts = opts || {};
    if (!v || !container) return null;
    var at = opts.at != null ? opts.at : posterAtSeconds(v);
    var key = posterCacheKey(v, at);
    var cached = posterImageCache[key] || readSessionPoster(key);
    if (cached) {
      posterImageCache[key] = cached;
      var img = showPosterImage(container, cached);
      if (opts.onReady) opts.onReady(img);
      return img;
    }
    var rec = { v: v, container: container, opts: opts };
    var observer = ensurePosterObserver();
    if (!observer) {
      enqueuePosterJob(rec);
      return null;
    }
    if (posterPending) posterPending.set(container, rec);
    observer.observe(container);
    return null;
  }

  function tgUrlForVideo(v, tgUser) {
    var price = Number(v.price) || 0;
    var priceLabel = Number.isInteger(price) ? String(price) : price.toFixed(2);
    var msg =
      'Hi 👋\n' +
      'I want to purchase:\n' +
      '📦 Content: ' + String(v.title || 'ALL CONTENT') + '\n' +
      '💰 Price: $' + priceLabel + '\n' +
      'Please send me the payment details.';
    var enc = encodeURIComponent(msg);
    if (tgUser) return 'https://t.me/' + tgUser + '?text=' + enc;
    return 'https://t.me/share/url?url=&text=' + enc;
  }

  function tgUrlCryptoProof(v, tgUser, wallets) {
    var lines = (wallets || []).map(function (w) {
      return '• ' + String(w.label || w.symbol || 'Wallet').toUpperCase() + ': ' + String(w.address || '');
    }).join('\n');
    var msg =
      'Crypto $' + Number(v.price).toFixed(2) + ' — ' + v.title + '\n' +
      lines + '\n' +
      'TX hash:';
    var enc = encodeURIComponent(msg);
    if (tgUser) return 'https://t.me/' + tgUser + '?text=' + enc;
    return 'https://t.me/share/url?url=&text=' + enc;
  }

  function tgUrlPaymentSuccess(info, tgUser) {
    var lines = [
      '🎉 Payment successful!',
      '',
      '🎬 **Video:** ' + (info.displayTitle || info.product || 'Digital purchase'),
      info.amount ? '💰 **Amount:** $' + info.amount + ' USD' : '',
      info.orderId ? '🧾 **Order:** ' + info.orderId : '',
      info.videoId ? '🆔 **Reference:** ' + info.videoId : '',
      '',
      'Please send me access to the content. Thank you!'
    ].filter(Boolean).join('\n');
    var enc = encodeURIComponent(lines);
    if (tgUser) return 'https://t.me/' + tgUser + '?text=' + enc;
    return 'https://t.me/share/url?url=&text=' + enc;
  }

  function copyToClipboard(text, btn) {
    text = String(text || '');
    if (btn && !btn.getAttribute('data-label')) {
      btn.setAttribute('data-label', (btn.textContent || 'Copy').trim());
    }
    function done(ok) {
      if (!btn) return;
      btn.textContent = ok ? 'Copied' : 'Copy failed';
      setTimeout(function () {
        btn.textContent = btn.getAttribute('data-label') || 'Copy';
      }, 1600);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }).catch(function () { done(false); });
      return;
    }
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done(true);
    } catch (e) {
      done(false);
    }
  }

  function resolvePlaybackUrl(v) {
    if (v.public_video_url && /^https?:\/\//i.test(String(v.public_video_url).trim())) {
      return Promise.resolve(String(v.public_video_url).trim());
    }
    if (v.playback_url && /^https?:\/\//i.test(v.playback_url)) {
      return Promise.resolve(v.playback_url);
    }
    if (v.wasabi_video_key) return fetchSigned(v.wasabi_video_key);
    return Promise.resolve(null);
  }

  global.Storefront = {
    MASKED_PRODUCT_NAME: MASKED_PRODUCT_NAME,
    normalizeOrigin: normalizeOrigin,
    pickMaskedName: pickMaskedName,
    ebooksSuccessUrl: ebooksSuccessUrl,
    checkoutUrl: checkoutUrl,
    watchUrl: watchUrl,
    formatDuration: formatDuration,
    formatViews: formatViews,
    formatDateRel: formatDateRel,
    escapeHtml: escapeHtml,
    escapeAttr: escapeAttr,
    fetchSigned: fetchSigned,
    tgUrlForVideo: tgUrlForVideo,
    tgUrlCryptoProof: tgUrlCryptoProof,
    tgUrlPaymentSuccess: tgUrlPaymentSuccess,
    copyToClipboard: copyToClipboard,
    resolvePlaybackUrl: resolvePlaybackUrl,
    DEFAULT_POSTER_AT: DEFAULT_POSTER_AT,
    posterAtSeconds: posterAtSeconds,
    applyVideoPoster: applyVideoPoster,
    hydrateVideoPoster: hydrateVideoPoster,
    resetPosterHydration: resetPosterHydration
  };
})(typeof window !== 'undefined' ? window : this);
