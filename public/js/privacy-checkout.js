(function (global) {
  var COUNTDOWN_SEC = 8;
  var timer = null;
  var pendingProceed = null;
  var injected = false;

  function injectOnce() {
    if (injected) return;
    injected = true;

    var style = document.createElement('style');
    style.id = 'privacy-checkout-styles';
    style.textContent =
      '.privacy-modal-copy { font-size: 0.875rem; line-height: 1.55; color: var(--muted, #a1a1aa); margin: 0 0 0.85rem; }' +
      '.privacy-modal-name {' +
      '  display: block; margin: 0.65rem 0 0.85rem; padding: 0.75rem 0.9rem;' +
      '  border-radius: 10px; background: var(--surface, #151518); border: 1px solid var(--stroke, rgba(255,255,255,0.08));' +
      '  font-family: ui-monospace, Consolas, monospace; font-size: 0.95rem; font-weight: 700;' +
      '  color: var(--primary, #ff2d55); text-align: center; letter-spacing: 0.02em;' +
      '}' +
      '.privacy-modal-price {' +
      '  margin: 0 0 0.65rem; padding: 0.75rem 0.9rem; border-radius: 10px;' +
      '  background: var(--surface, #151518); border: 1px solid var(--stroke, rgba(255,255,255,0.08));' +
      '  text-align: center;' +
      '}' +
      '.privacy-modal-usd { font-size: 1.05rem; font-weight: 700; color: var(--text, #f5f5f7); }' +
      '.privacy-modal-hint { font-size: 0.72rem; line-height: 1.45; color: var(--muted, #a1a1aa); margin: 0 0 1rem; text-align: center; }' +
      '.privacy-modal-actions { display: flex; flex-direction: column; gap: 0.45rem; }' +
      '#dlg-privacy-go:disabled { opacity: 0.55; cursor: not-allowed; }';
    document.head.appendChild(style);

    var dlg = document.createElement('dialog');
    dlg.id = 'dlg-privacy';
    dlg.className = 'dlg-modal';
    dlg.setAttribute('aria-labelledby', 'dlg-privacy-heading');
    dlg.innerHTML =
      '<div class="dlg-h">' +
        '<strong id="dlg-privacy-heading">Discreet billing</strong>' +
        '<button type="button" class="dlg-x" id="dlg-privacy-close" aria-label="Close">×</button>' +
      '</div>' +
      '<div class="dlg-b">' +
        '<p class="privacy-modal-copy">' +
          'For your privacy, the name on your bank or card statement will be generic — not the video title.' +
        '</p>' +
        '<span class="privacy-modal-name" id="dlg-privacy-name">Digital Ebook</span>' +
        '<div class="privacy-modal-price" id="dlg-privacy-price" hidden>' +
          '<div class="privacy-modal-usd" id="dlg-privacy-usd"></div>' +
        '</div>' +
        '<p class="privacy-modal-hint" id="dlg-privacy-countdown">Please read — you can continue in 8s.</p>' +
        '<div class="privacy-modal-actions">' +
          '<button type="button" class="btn btn-primary btn-block" id="dlg-privacy-go" disabled>Continue in 8s</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(dlg);

    dlg.querySelector('#dlg-privacy-close').addEventListener('click', close);
    dlg.addEventListener('close', syncBodyClass);
    dlg.addEventListener('cancel', function (e) {
      e.preventDefault();
      close();
    });
    dlg.querySelector('#dlg-privacy-go').addEventListener('click', function () {
      if (this.disabled) return;
      proceed();
    });
  }

  function syncBodyClass() {
    var privacy = document.getElementById('dlg-privacy');
    var details = document.getElementById('dlg-details');
    var open = (privacy && privacy.open) || (details && details.open);
    document.body.classList.toggle('modal-dlg-open', !!open);
  }

  function resetCountdown(btn, countdownEl) {
    clearInterval(timer);
    timer = null;
    var left = COUNTDOWN_SEC;
    btn.disabled = true;
    btn.textContent = 'Continue in ' + left + 's';
    countdownEl.textContent = 'Please read — you can continue in ' + left + 's.';
    timer = setInterval(function () {
      left -= 1;
      if (left > 0) {
        btn.textContent = 'Continue in ' + left + 's';
        countdownEl.textContent = 'Please read — you can continue in ' + left + 's.';
        return;
      }
      clearInterval(timer);
      timer = null;
      btn.disabled = false;
      btn.textContent = 'Continue to checkout';
      countdownEl.textContent = 'Review the final total and payment currency at checkout.';
    }, 1000);
  }

  function updatePriceBlock(opts) {
    var block = document.getElementById('dlg-privacy-price');
    var usdEl = document.getElementById('dlg-privacy-usd');
    if (!block || !usdEl) return;

    var usd = opts && opts.priceUsd != null ? Number(opts.priceUsd) : NaN;
    if (!Number.isFinite(usd) || usd <= 0) {
      block.hidden = true;
      return;
    }

    block.hidden = false;
    usdEl.textContent = '$' + usd.toFixed(2) + ' USD';
  }

  function open(onProceed, opts) {
    injectOnce();
    pendingProceed = typeof onProceed === 'function' ? onProceed : null;
    var dlg = document.getElementById('dlg-privacy');
    var btn = document.getElementById('dlg-privacy-go');
    var countdownEl = document.getElementById('dlg-privacy-countdown');
    var nameEl = document.getElementById('dlg-privacy-name');
    if (!dlg || !btn || !countdownEl) return;

    var masked = (opts && opts.maskedName) ? String(opts.maskedName).trim() : 'Digital Ebook';
    if (nameEl) nameEl.textContent = masked || 'Digital Ebook';

    updatePriceBlock(opts);
    resetCountdown(btn, countdownEl);
    dlg.showModal();
    syncBodyClass();
  }

  function proceed() {
    var fn = pendingProceed;
    pendingProceed = null;
    close();
    if (fn) fn();
  }

  function close() {
    clearInterval(timer);
    timer = null;
    pendingProceed = null;
    var dlg = document.getElementById('dlg-privacy');
    if (dlg && dlg.open) dlg.close();
    syncBodyClass();
  }

  global.PrivacyCheckout = {
    open: open,
    close: close,
    syncBodyClass: syncBodyClass
  };
})(typeof window !== 'undefined' ? window : this);
