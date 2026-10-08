import crypto from 'node:crypto';

/**
 * PayJSR checkout on videos-site (same-origin) — payment-link matching.
 */

const PAYJSR_CHECKOUT_CURRENCY = 'ZAR';
const PAYJSR_API_BASE = 'https://checkout.payjsr.com/api';


function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeCurrencyCode(raw, fallback = 'USD') {
  const code = String(raw || fallback).toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : fallback;
}

function majorToMinor(amountMajor, decimals = 2) {
  const n = Number(amountMajor);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10 ** decimals);
}

function minorToMajor(amountMinor, decimals = 2) {
  const n = Number(amountMinor);
  if (!Number.isFinite(n)) return 0;
  return n / 10 ** decimals;
}

function getPayJSRPaymentLinks() {
  const raw = String(process.env.PAYJSR_PAYMENT_LINKS || '').trim();
  if (!raw) return [];

  if (raw.startsWith('[')) {
    try {
      const list = JSON.parse(raw);
      return (Array.isArray(list) ? list : [])
        .map((item) => ({
          amountZar: item.amount_zar != null ? Number(item.amount_zar) : null,
          amountUsd: item.amount_usd != null ? Number(item.amount_usd) : null,
          url: String(item.url || '').trim(),
        }))
        .filter((item) => item.url && /^https?:\/\//i.test(item.url));
    } catch {
      return [];
    }
  }

  return raw
    .split(/[\n;]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const sep = line.includes('|') ? '|' : ',';
      const [pricePart, ...urlParts] = line.split(sep);
      const url = urlParts.join(sep).trim();
      if (!url || !/^https?:\/\//i.test(url)) return null;
      const token = String(pricePart || '').trim().toLowerCase();
      let amountZar = null;
      let amountUsd = null;
      if (/^usd:/.test(token) || /usd$/.test(token)) {
        amountUsd = Number(token.replace(/^usd:/, '').replace(/usd$/, ''));
      } else if (/^zar:/.test(token) || /zar$/.test(token)) {
        amountZar = Number(token.replace(/^zar:/, '').replace(/zar$/, ''));
      } else {
        amountZar = Number(token);
      }
      return {
        amountZar: Number.isFinite(amountZar) ? amountZar : null,
        amountUsd: Number.isFinite(amountUsd) ? amountUsd : null,
        url,
      };
    })
    .filter(Boolean);
}

function findMatchingPayJSRLink({ listAmountMajor, listCurrency, zarAmountMajor, tolerance = 0.12 }) {
  const links = getPayJSRPaymentLinks();
  if (!links.length) return null;

  const listCur = normalizeCurrencyCode(listCurrency, 'USD');
  const listAmt = Number(listAmountMajor);
  const zarAmt = Number(zarAmountMajor);
  const scored = [];

  for (const link of links) {
    let score = Infinity;
    let matchType = '';

    if (link.amountUsd != null && listCur === 'USD' && Number.isFinite(listAmt)) {
      const diff = Math.abs(link.amountUsd - listAmt);
      if (diff < 0.005) {
        score = 0;
        matchType = 'exact_usd';
      } else if (listAmt > 0 && diff / listAmt <= tolerance) {
        score = diff / listAmt;
        matchType = 'approx_usd';
      }
    }

    if (link.amountZar != null && Number.isFinite(zarAmt) && zarAmt > 0) {
      const diff = Math.abs(link.amountZar - zarAmt);
      if (diff < 0.05) {
        score = Math.min(score, 0);
        matchType = matchType || 'exact_zar';
      } else if (diff / zarAmt <= tolerance) {
        const s = diff / zarAmt;
        if (s < score) {
          score = s;
          matchType = 'approx_zar';
        }
      }
    }

    if (score < Infinity) scored.push({ link, score, matchType });
  }

  if (!scored.length) return null;
  scored.sort((a, b) => a.score - b.score);
  return scored[0];
}

let fxQuoteCache = new Map();

async function publicFxQuote(fromCurrency, toCurrency, amountMinor, toDecimals = 2) {
  const from = normalizeCurrencyCode(fromCurrency);
  const to = normalizeCurrencyCode(toCurrency);
  const amount = Math.max(1, Math.round(Number(amountMinor) || 0));
  if (from === to) {
    return { amountMinor: amount, rate: 1, decimals: toDecimals, source: 'identity' };
  }

  const amountMajor = minorToMajor(amount, 2);
  const providers = [
    async () => {
      const url = `https://api.frankfurter.app/latest?amount=${amountMajor}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      const data = await res.json().catch(() => ({}));
      const convertedMajor = data?.rates?.[to];
      if (convertedMajor == null || !Number.isFinite(Number(convertedMajor))) return null;
      return {
        amountMinor: majorToMinor(Number(convertedMajor), toDecimals),
        rate: Number(convertedMajor) / amountMajor,
        decimals: toDecimals,
        source: 'frankfurter',
      };
    },
    async () => {
      const url = `https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      const data = await res.json().catch(() => ({}));
      const pairRate = data?.rates?.[to];
      if (pairRate == null || !Number.isFinite(Number(pairRate))) return null;
      return {
        amountMinor: majorToMinor(amountMajor * Number(pairRate), toDecimals),
        rate: Number(pairRate),
        decimals: toDecimals,
        source: 'open.er-api',
      };
    },
  ];

  for (const provider of providers) {
    try {
      const quote = await provider();
      if (quote) return quote;
    } catch (err) {
      console.warn('FX provider failed:', err?.message || err);
    }
  }
  throw new Error('FX quote unavailable');
}

async function cachedFxQuote(fromCurrency, toCurrency, amountMinor, toDecimals = 2) {
  const from = normalizeCurrencyCode(fromCurrency);
  const to = normalizeCurrencyCode(toCurrency);
  const amount = Math.max(1, Math.round(Number(amountMinor) || 0));
  const key = `${from}:${to}:${amount}`;
  const hit = fxQuoteCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.quote;
  const quote = await publicFxQuote(from, to, amount, toDecimals);
  fxQuoteCache.set(key, { at: Date.now(), quote });
  return quote;
}

const CHECKOUT_CSS = `
  :root {
    --bg: #0b0b0d;
    --paper: #151518;
    --surface: #1e1e24;
    --primary: #ff2d55;
    --primary-hover: #e02548;
    --text: #f5f5f7;
    --muted: #a1a1aa;
    --border: rgba(255,255,255,0.1);
    --success: #3dd68c;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { color-scheme: dark; }
  body {
    font-family: 'DM Sans', system-ui, -apple-system, sans-serif;
    min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    padding: 28px 18px;
    background: var(--bg);
    background-image: radial-gradient(ellipse 80% 50% at 50% -18%, rgba(255,45,85,0.12), transparent 60%);
    color: var(--text);
  }
  .wrap { width: 100%; max-width: 420px; }
  .card {
    border-radius: 14px; background: var(--paper);
    border: 1px solid var(--border);
    box-shadow: 0 16px 48px rgba(0,0,0,0.45); overflow: hidden;
  }
  .card-accent { height: 3px; background: var(--primary); }
  .card-body { padding: 1.45rem 1.35rem 1.25rem; }
  .eyebrow {
    font-size: 0.68rem; font-weight: 700; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--primary); margin-bottom: 0.3rem;
  }
  .brand { font-size: 1.15rem; font-weight: 700; margin-bottom: 0.65rem; letter-spacing: -0.02em; }
  .divider { height: 1px; background: var(--border); margin: 0.15rem 0 0.85rem; }
  .label {
    font-size: 0.62rem; font-weight: 700; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--muted); margin-bottom: 0.25rem;
  }
  .real { font-size: 0.95rem; font-weight: 600; margin-bottom: 0.55rem; line-height: 1.42; }
  .privacy-callout {
    font-size: 0.72rem; line-height: 1.52; color: var(--muted);
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; padding: 0.7rem 0.85rem; margin-bottom: 0.9rem;
  }
  .privacy-callout strong {
    display: block; font-size: 0.65rem; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--text); margin-bottom: 0.35rem;
  }
  .fx-panel {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 10px; padding: 0.85rem 0.9rem; margin-bottom: 0.95rem;
  }
  .amount {
    font-size: 1.85rem; font-weight: 700; color: var(--primary);
    margin-bottom: 0.55rem; letter-spacing: -0.03em;
  }
  .amount .cur-code { font-size: 0.78rem; font-weight: 600; color: var(--muted); margin-left: 6px; }
  .fx-row { margin-top: 0.45rem; }
  .fx-row select {
    width: 100%; padding: 0.55rem 0.65rem; border-radius: 8px;
    border: 1px solid var(--border); background: var(--bg); color: var(--text);
    font: inherit; font-size: 0.85rem;
  }
  .fx-equiv { font-size: 0.92rem; font-weight: 600; margin-top: 0.5rem; }
  .fx-note { font-size: 0.7rem; line-height: 1.45; color: var(--muted); margin-top: 0.55rem; }
  .btn {
    display: block; width: 100%; text-align: center; font-weight: 700;
    padding: 0.9rem 1rem; border-radius: 10px; margin-top: 0;
    background: var(--primary); color: #fff; border: none; cursor: pointer;
    font-family: inherit; font-size: 0.95rem; text-decoration: none;
    box-shadow: 0 4px 22px rgba(255,45,85,0.35);
  }
  .btn:hover { background: var(--primary-hover); }
  .fine { font-size: 0.72rem; color: var(--muted); text-align: center; margin-top: 0.7rem; line-height: 1.48; }
  .back { display: block; text-align: center; margin-top: 0.55rem; font-size: 0.72rem; color: var(--muted); }
  .cancel-banner {
    font-size: 0.82rem; line-height: 1.45; color: #fbbf24;
    background: rgba(251,191,36,0.1); border: 1px solid rgba(251,191,36,0.35);
    border-radius: 8px; padding: 0.65rem 0.75rem; margin-bottom: 0.85rem;
  }
`;

function sendPayJSRCheckoutPage(res, payload) {
  const {
    siteName,
    checkoutUrl,
    realTitle,
    maskedLabel,

    listAmountMajor,
    listCurrency,
    canceled,
    cancelHref,
  } = payload;

  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <title>${escapeHtml(siteName)} · Checkout</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${CHECKOUT_CSS}</style>
  <link rel="stylesheet" href="/css/storefront.css">
</head>
<body>
  <div class="wrap">
    <article class="card">
      <div class="card-accent" aria-hidden="true"></div>
      <div class="card-body">
        <p class="eyebrow">Secure checkout</p>
        <h1 class="brand">${escapeHtml(siteName)}</h1>
        <div class="divider"></div>
        ${canceled ? '<div class="cancel-banner">Payment cancelled. No charges were made — you can try again below.</div>' : ''}
        <p class="label">Your order</p>
        <p class="real">${escapeHtml(realTitle)}</p>
        <div class="privacy-callout" role="status">
          <strong>Privacy</strong>
          <span>Processor sees a neutral label (<span style="font-family:ui-monospace,monospace;color:var(--primary)">${escapeHtml(maskedLabel)}</span>). Your bank statement stays discreet.</span>
        </div>
        <div class="fx-panel">
          <p class="label">List price</p>
          <p class="amount">${escapeHtml(listAmountMajor)} <span class="cur-code">${escapeHtml(listCurrency)}</span></p>
          <p class="fx-note">Review the final total and payment currency on the payment provider's checkout.</p>
        </div>
        <a class="btn" id="btn-payjsr" href="${escapeHtml(checkoutUrl)}">Continue to payment</a>
        <p class="fine">Instant access after payment confirmation.</p>
        <a class="back" href="${escapeHtml(cancelHref || '/')}">← Back to store</a>
      </div>
    </article>
  </div>

</body>
</html>`);
}

export function registerPayjsrRoutes(app, { siteName, getVideoForCheckout, getAllVideosForBundle, getTelegramUsername, recordPayjsrPurchase }) {
  app.get('/api/payjsr-fx', async (req, res) => {
    try {
      const from = normalizeCurrencyCode(req.query.from, PAYJSR_CHECKOUT_CURRENCY);
      const to = normalizeCurrencyCode(req.query.to, 'USD');
      const amount = Math.max(1, Math.round(Number(req.query.amount) || 0));
      const quote = await cachedFxQuote(from, to, amount, 2);
      res.json({
        ok: true,
        from,
        to,
        amount_minor: quote.amountMinor,
        rate: quote.rate,
        source: quote.source,
      });
    } catch (err) {
      res.status(502).json({ ok: false, error: err?.message || 'FX unavailable' });
    }
  });

  async function handleCheckout(req, res) {
    try {
      const q = req.query;
      const isBundle = String(q.bundle || '').toLowerCase() === 'all';
      const videoId = String(q.video_id || '').trim();
      if ((!videoId && !isBundle) || (!isBundle && typeof getVideoForCheckout !== 'function')) {
        return res.status(400).send('Missing video. Please return to the store and try again.');
      }
      let video = null;
      let bundleProducts = [];
      if (isBundle) {
        if (typeof getAllVideosForBundle !== 'function') {
          return res.status(503).send('The all-content package is not configured.');
        }
        bundleProducts = await getAllVideosForBundle();
        const paidProducts = bundleProducts.filter((item) => !item.is_free && Number(item.price) > 0);
        if (!paidProducts.length) {
          return res.status(404).send('The all-content package is not available.');
        }
      } else {
        video = await getVideoForCheckout(videoId);
        if (!video || !video.is_active || video.is_free || !(Number(video.price) > 0)) {
          return res.status(404).send('This video is unavailable for purchase.');
        }
      }
      const amountNumber = isBundle ? 150 : Number(video.price);
      if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
        return res.status(400).send('Missing or invalid amount');
      }

      const listCurrency = normalizeCurrencyCode(q.currency, 'USD');
      const listAmountMinor = majorToMinor(amountNumber, 2);
      if (listAmountMinor < 50) {
        return res.status(400).send('Amount too small (minimum is $0.50)');
      }
      if (!['ZAR', 'USD', 'EUR'].includes(listCurrency)) {
        return res.status(400).send('Unsupported currency. Use ZAR, USD or EUR.');
      }

      const masked = String(q.product_name || 'Digital Ebook').trim() || 'Digital Ebook';
      const real = isBundle ? 'All videos and folders' : String(video.title || q.display_title || masked).trim();
      const canceled = String(q.payment_canceled || '').toLowerCase() === 'true';
      const wantJson =
        String(q.format || '').toLowerCase() === 'json' ||
        String(req.get('accept') || '').includes('application/json');

      const secretKey = String(process.env.PAYJSR_SECRET_KEY || process.env.PAYJSR_API_KEY || '').trim();
      if (!secretKey) {
        return res.status(503).send('PayJSR is not configured. Set PAYJSR_SECRET_KEY on this service.');
      }
      const expectedOrigin = `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`;
      const reference = crypto.randomUUID();
      const successUrl = `${expectedOrigin}/?status=success&reference=${encodeURIComponent(reference)}`;
      let apiResponse;
      try {
        apiResponse = await fetch(`${PAYJSR_API_BASE}/v1/checkout/sessions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${secretKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': reference,
          },
          body: JSON.stringify({
            amount: amountNumber,
            currency: listCurrency,
            name: masked.slice(0, 120),
            success_url: successUrl,
            reference,
            metadata: isBundle
              ? { bundle: 'all', display_title: real.slice(0, 500) }
              : { video_id: videoId, display_title: real.slice(0, 500), delivery_url: String(video.product_link).trim() },
          }),
        });
      } catch (err) {
        console.error('PayJSR API request failed:', err?.message || err);
        return res.status(502).send('Could not reach PayJSR. Please try again.');
      }
      const session = await apiResponse.json().catch(() => ({}));
      const checkoutUrl = session.url || session.data?.url || session.checkout_session?.url;
      if (!apiResponse.ok || !checkoutUrl || !/^https:\/\//i.test(checkoutUrl)) {
        console.error('PayJSR session creation failed:', apiResponse.status, session);
        return res.status(502).send('PayJSR could not create this checkout. Please try again.');
      }

      console.log('PayJSR checkout session created:', { amount: amountNumber, currency: listCurrency });

      if (wantJson) {
        return res.json({
          ok: true,
          checkout_url: checkoutUrl,
          amount: amountNumber,
          currency_list: listCurrency,
          product_name: masked,
          display_title: real,
        });
      }

      // Send the buyer to the hosted PayJSR checkout.
      if (String(q.redirect || '1') !== '0') {
        return res.redirect(302, checkoutUrl);
      }

      return sendPayJSRCheckoutPage(res, {
        siteName: siteName || 'Checkout',
        checkoutUrl,
        realTitle: real,
        maskedLabel: masked,
        zarAmountMajor: '',
        zarAmountMinor: 0,
        listAmountMajor: amountNumber.toFixed(2),
        listCurrency,
        canceled,
        cancelHref: '/',
      });
    } catch (err) {
      console.error('PayJSR checkout error:', err);
      if (String(req.query.format || '').toLowerCase() === 'json') {
        return res.status(500).json({ ok: false, error: 'Checkout failed' });
      }
      return res.status(500).send('Checkout failed. Please try again.');
    }
  }

  app.get('/api/payjsr-checkout', handleCheckout);
  app.get('/api/paypal-checkout', handleCheckout);

  app.get('/api/payjsr-success', async (req, res) => {
    try {
      const reference = String(req.query.reference || '').trim();
      if (!/^[0-9a-f-]{36}$/i.test(reference)) {
        return res.status(400).json({ ok: false, error: 'Invalid payment reference.' });
      }
      const secretKey = String(process.env.PAYJSR_SECRET_KEY || process.env.PAYJSR_API_KEY || '').trim();
      if (!secretKey) return res.status(503).json({ ok: false, error: 'PayJSR is not configured.' });
      const apiResponse = await fetch(`${PAYJSR_API_BASE}/v1/checkout/sessions?limit=100&reference=${encodeURIComponent(reference)}`, {
        headers: { Authorization: `Bearer ${secretKey}` },
      });
      const payload = await apiResponse.json().catch(() => ({}));
      if (!apiResponse.ok) {
        console.error('PayJSR session verification failed:', apiResponse.status, payload);
        return res.status(502).json({ ok: false, error: 'Could not verify payment yet.' });
      }
      const sessions = Array.isArray(payload) ? payload :
        Array.isArray(payload.data) ? payload.data :
        Array.isArray(payload.sessions) ? payload.sessions :
        Array.isArray(payload.data?.sessions) ? payload.data.sessions : [];
      const session = sessions.find((item) => item?.reference === reference);
      if (!session || session.status !== 'complete') {
        return res.status(402).json({ ok: false, pending: true, error: 'Payment is not confirmed yet.' });
      }
      if (String(session.metadata?.bundle || '').toLowerCase() === 'all') {
        if (typeof recordPayjsrPurchase === 'function') {
          try {
            await recordPayjsrPurchase(session, { title: 'All videos and folders', bundle: 'all', reference, amount: session.amount, currency: session.currency });
          } catch (saveError) {
            console.error('PayJSR purchase save failed:', saveError.message);
          }
        }
        return res.json({
          ok: true,
          title: 'All videos and folders',
          amount: session.amount,
          currency: session.currency,
          delivery_via_telegram: true,
          telegram_username: typeof getTelegramUsername === 'function' ? await getTelegramUsername() : '',
        });
      }

      const videoId = String(session.metadata?.video_id || '').trim();
      if (!videoId || typeof getVideoForCheckout !== 'function') {
        return res.status(404).json({ ok: false, error: 'Purchased product was not found.' });
      }
      const video = await getVideoForCheckout(videoId);
      if (!video) return res.status(404).json({ ok: false, error: 'Purchased product was not found.' });
      const productLink = String(session.metadata?.delivery_url || video.product_link || '').trim();
      const safeProductLink = /^https?:\/\//i.test(productLink) ? productLink : '';
      if (typeof recordPayjsrPurchase === 'function') {
        try {
          await recordPayjsrPurchase(session, {
            title: video.title || 'Your purchase',
            video_id: videoId,
            reference,
            product_link: safeProductLink,
            amount: session.amount,
            currency: session.currency,
          });
        } catch (saveError) {
          console.error('PayJSR purchase save failed:', saveError.message);
        }
      }
      res.json({
        ok: true,
        title: video.title || 'Your purchase',
        amount: session.amount,
        currency: session.currency,
        product_link: safeProductLink,
        delivery_pending: !safeProductLink,
        telegram_username: typeof getTelegramUsername === 'function' ? await getTelegramUsername() : '',
      });
    } catch (err) {
      console.error('PayJSR payment verification error:', err?.message || err);
      res.status(500).json({ ok: false, error: 'Payment verification failed.' });
    }
  });
}
