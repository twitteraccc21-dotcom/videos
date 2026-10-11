import crypto from 'node:crypto';

const ALLOWED_EVENTS = new Set([
  'payment.succeeded', 'payment.failed', 'payment.expired',
  'payment.partially_refunded', 'payment.refunded', 'payment.disputed', 'payment.dispute_lost',
]);

function config() {
  let fixedProducts = {};
  try {
    const raw = String(process.env.WALLED_FIXED_PRODUCTS_JSON || '').trim();
    if (raw) fixedProducts = JSON.parse(raw);
  } catch { fixedProducts = {}; }
  return {
    baseUrl: String(process.env.WALLED_API_BASE_URL || '').trim().replace(/\/+$/, ''),
    appOrigin: String(process.env.WALLED_APP_ORIGIN || '').trim().replace(/\/+$/, ''),
    apiKey: String(process.env.WALLED_API_KEY || '').trim(),
    productId: String(process.env.WALLED_PRODUCT_ID || '').trim(),
    webhookSecret: String(process.env.WALLED_WEBHOOK_SECRET || '').trim(),
    variablePricing: String(process.env.WALLED_VARIABLE_PRICING || '').trim().toLowerCase() === 'true',
    fixedPriceUsd: Number(process.env.WALLED_FIXED_PRICE_USD),
    fixedProducts,
  };
}

function productForPrice(c, amount) {
  if (c.variablePricing) return { amount, productId: c.productId };
  const entries = Object.entries(c.fixedProducts || {})
    .map(([price, productId]) => ({ amount: Number(price), productId: String(productId || '').trim() }))
    .filter(x => Number.isFinite(x.amount) && x.amount > 0 && x.productId);
  if (!entries.length && Number.isFinite(c.fixedPriceUsd) && c.fixedPriceUsd > 0 && c.productId) {
    entries.push({ amount: c.fixedPriceUsd, productId: c.productId });
  }
  if (!entries.length) return null;
  const target = minorUnits(amount);
  return entries.map(x => ({ ...x, minor: minorUnits(x.amount) }))
    .sort((a, b) => Math.abs(a.minor - target) - Math.abs(b.minor - target) || a.minor - b.minor)[0];
}

function isConfigured(c) {
  try {
    const base = new URL(c.baseUrl);
    const origin = new URL(c.appOrigin);
    return base.protocol === 'https:' && origin.protocol === 'https:' && origin.origin === c.appOrigin
      && origin.pathname === '/' && !origin.search && !origin.hash
      && Boolean(c.apiKey && (c.productId || (!c.variablePricing && Object.keys(c.fixedProducts || {}).length)));
  } catch { return false; }
}
function uuid() { return crypto.randomUUID(); }
function minorUnits(amount) { return Math.round(Number(amount) * 100); }

function signatureIsValid(rawBody, header, secret) {
  if (!Buffer.isBuffer(rawBody) || !header || !secret) return false;
  const parts = String(header).split(',');
  const values = new Map();
  for (const part of parts) {
    const match = part.trim().match(/^(t|v1)=([a-fA-F0-9]+)$/);
    if (!match || values.has(match[1])) return false;
    values.set(match[1], match[2]);
  }
  const timestamp = values.get('t');
  const signature = values.get('v1');
  if (!timestamp || !/^\d+$/.test(timestamp) || !signature || signature.length !== 64) return false;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(Date.now() / 1000 - seconds) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(timestamp, 'ascii').update('.', 'ascii').update(rawBody).digest();
  const supplied = Buffer.from(signature, 'hex');
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function orderKey(req) {
  const key = String(req.body?.requestKey || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key) ? key.toLowerCase() : '';
}

export function registerWalledRoutes(app, { getVideoForCheckout, getAllVideosForBundle, getTelegramUsername, recordWalledPurchase }) {
  app.post('/api/walled-checkout', async (req, res) => {
    const c = config();
    if (!isConfigured(c)) return res.status(503).json({ error: 'Walled checkout is not configured on the server.' });
    if (!c.variablePricing && !Object.keys(c.fixedProducts || {}).length && (!Number.isFinite(c.fixedPriceUsd) || c.fixedPriceUsd <= 0)) {
      return res.status(503).json({ error: 'Configure at least one fixed Walled product price.' });
    }
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'Invalid checkout request.' });

    try {
      const supabase = typeof req.app.locals.getSupabase === 'function' ? req.app.locals.getSupabase() : null;
      if (!supabase) return res.status(503).json({ error: 'Checkout storage is unavailable.' });
      const requestKey = orderKey(req);
      if (!requestKey) return res.status(400).json({ error: 'Invalid checkout request key.' });

      const isBundle = req.body.bundle === true;
      let video = null;
      let amount;
      let title;
      if (isBundle) {
        const videos = await getAllVideosForBundle();
        if (!videos.length) return res.status(404).json({ error: 'No active videos are available.' });
        amount = 100;
        title = 'All videos and folders';
      } else {
        const videoId = String(req.body.videoId || '').trim();
        if (!videoId) return res.status(400).json({ error: 'Choose a video before checkout.' });
        video = await getVideoForCheckout(videoId);
        if (!video || !video.is_active || video.is_free) return res.status(404).json({ error: 'This video is not available for purchase.' });
        amount = Number(video.price);
        title = String(video.title || 'Digital video').slice(0, 180);
      }
      if (!Number.isFinite(amount) || amount <= 0 || minorUnits(amount) > 99999999) {
        return res.status(400).json({ error: 'The configured purchase price is invalid.' });
      }
      const selectedProduct = productForPrice(c, amount);
      if (!selectedProduct) return res.status(503).json({ error: 'No fixed Walled products are configured.' });
      const requestedAmountMinor = minorUnits(amount);
      const chargedAmountMinor = minorUnits(selectedProduct.amount);
      const acceptedAmountMinor = req.body.acceptedAmountMinor == null ? null : Number(req.body.acceptedAmountMinor);
      if (!c.variablePricing && chargedAmountMinor !== requestedAmountMinor && acceptedAmountMinor == null) {
        return res.json({ priceAdjustmentRequired: true, requestedAmountMinor, chargedAmountMinor });
      }
      if (!c.variablePricing && chargedAmountMinor !== requestedAmountMinor && acceptedAmountMinor !== chargedAmountMinor) {
        return res.status(409).json({ error: 'The selected Walled price changed. Review the updated amount and try again.' });
      }

      let { data: order, error } = await supabase.from('walled_orders').select('*').eq('request_key', requestKey).maybeSingle();
      if (error) throw error;
      if (order) {
        if (order.video_id !== (video?.id || null) || order.bundle !== isBundle
          || Number(order.amount_minor) !== chargedAmountMinor || order.product_id !== selectedProduct.productId) {
          return res.status(409).json({ error: 'This checkout request key was already used for different purchase details.' });
        }
        if (order.checkout_url) return res.json({ checkoutUrl: order.checkout_url });
        if (!['creating', 'checkout_error'].includes(order.status)) return res.status(409).json({ error: 'This purchase already has a checkout attempt. Please contact support.' });
      } else {
        const orderId = uuid();
        const row = {
          order_id: orderId, request_key: requestKey, video_id: video?.id || null,
          bundle: isBundle, title, amount_minor: chargedAmountMinor, currency: 'usd',
          product_id: selectedProduct.productId, status: 'creating',
          metadata: {
            video_id: video?.id || null, title, bundle: isBundle ? 'all' : null,
            requested_amount_minor: requestedAmountMinor,
          },
        };
        ({ data: order, error } = await supabase.from('walled_orders').insert(row).select('*').single());
        if (error) {
          if (error.code === '23505') return res.status(409).json({ error: 'Checkout is already being created. Please retry shortly.' });
          throw error;
        }
      }

      const origin = c.appOrigin;
      const payload = {
        productId: selectedProduct.productId,
        orderId: order.order_id,
        customerRef: order.order_id,
        successUrl: `${origin}/payment/success`,
        cancelUrl: `${origin}/payment/cancel`,
        ...(c.variablePricing ? { amount: requestedAmountMinor, currency: 'usd' } : {}),
        metadata: { video_id: video?.id || '', title, bundle: isBundle ? 'all' : '' },
      };
      const response = await fetch(`${c.baseUrl}/checkout/sessions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': order.order_id },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        await supabase.from('walled_orders').update({ status: 'checkout_error', last_error: `HTTP ${response.status}` }).eq('order_id', order.order_id);
        console.error('Walled checkout session failed:', response.status);
        return res.status(502).json({ error: 'Walled could not create this checkout. Check the product setup and try again.' });
      }
      if (typeof result.checkoutUrl !== 'string' || !/^https:\/\//i.test(result.checkoutUrl) || !result.sessionId) {
        return res.status(502).json({ error: 'Walled returned an invalid checkout session.' });
      }
      if (Number(result.amount) !== chargedAmountMinor || String(result.currency).toLowerCase() !== 'usd') {
        await supabase.from('walled_orders').update({
          session_id: result.sessionId, status: 'checkout_error', last_error: 'Walled price does not match the stored order.',
        }).eq('order_id', order.order_id);
        console.error('Walled checkout blocked because the configured product price did not match the order.');
        return res.status(409).json({ error: 'The Walled product price does not match this purchase.' });
      }
      const checkoutEnvironment = String(result.environment || '').toLowerCase();
      if (process.env.NODE_ENV !== 'production' && !['test', 'development'].includes(checkoutEnvironment)) {
        await supabase.from('walled_orders').update({ status: 'checkout_error', last_error: 'Non-development session blocked locally.' }).eq('order_id', order.order_id);
        console.error('Walled checkout blocked locally because the API key did not create a Development session.');
        return res.status(409).json({ error: 'This local checkout was blocked because Walled did not confirm Development mode.' });
      }
      const { error: saveError } = await supabase.from('walled_orders').update({
        session_id: result.sessionId, checkout_url: result.checkoutUrl,
        status: result.status || 'pending', environment: result.environment || null,
      }).eq('order_id', order.order_id);
      if (saveError) throw saveError;
      return res.json({ checkoutUrl: result.checkoutUrl });
    } catch (error) {
      console.error('Walled checkout error:', error?.message || error);
      return res.status(500).json({ error: 'Could not start checkout. Please try again.' });
    }
  });

  app.get('/payment/success', (req, res) => {
    const sessionId = String(req.query.sessionId || '');
    const sessionJson = JSON.stringify(sessionId).replace(/</g, '\\u003c');
    res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Payment status</title><main style="font:16px system-ui;max-width:36rem;margin:15vh auto;padding:1.5rem"><h1>Checking your payment</h1><p id="status">Your payment is being confirmed. This may take a moment.</p><a id="delivery" hidden target="_blank" rel="noopener">Get your content</a><p><a href="/">Return to videos</a></p></main><script>const id=${sessionJson};let tries=0;async function check(){if(!id){document.querySelector('#status').textContent='Payment reference is missing. Contact support.';return}try{const r=await fetch('/api/walled-status?sessionId='+encodeURIComponent(id));const d=await r.json();if(r.ok&&d.status==='paid'){document.querySelector('h1').textContent='Payment confirmed';document.querySelector('#status').textContent='Your purchase has been recorded.';const lines=['Hello, I just paid for '+(d.title||'my purchase')+'.','Amount: '+d.amount+' '+d.currency+'.','Payment reference: '+id+'.','Please send me access to my purchase.'].join('\\n');const user=String(d.telegram_username||'').replace(/^@/,'').trim();const link=document.querySelector('#delivery');link.href=user?'https://t.me/'+encodeURIComponent(user)+'?text='+encodeURIComponent(lines):'https://t.me/share/url?url=&text='+encodeURIComponent(lines);link.hidden=false;return}if(d.status==='refunded'||d.status==='disputed'||d.status==='dispute_lost'){document.querySelector('#status').textContent='Payment status: '+d.status;return}}catch(e){}if(++tries<8)setTimeout(check,2500);else document.querySelector('#status').textContent='Payment is still being confirmed. You can safely close this page; the confirmation will be processed automatically.'}check();</script>`);
  });
  app.get('/payment/cancel', (req, res) => res.redirect('/?payment_canceled=true'));

  app.get('/api/walled-status', async (req, res) => {
    const c = config();
    if (!isConfigured(c)) return res.status(503).json({ error: 'Walled checkout is not configured.' });
    const sessionId = String(req.query.sessionId || '').trim();
    if (!sessionId || sessionId.length > 100) return res.status(400).json({ error: 'Invalid payment reference.' });
    try {
      const supabase = req.app.locals.getSupabase?.();
      if (!supabase) return res.status(503).json({ error: 'Payment status is unavailable.' });
      const { data: order, error } = await supabase.from('walled_orders').select('*').eq('session_id', sessionId).maybeSingle();
      if (error) throw error;
      if (!order) return res.status(404).json({ error: 'Payment reference not found.' });
      const response = await fetch(`${c.baseUrl}/checkout/sessions/${encodeURIComponent(sessionId)}`, {
        headers: { Authorization: `Bearer ${c.apiKey}` }, signal: AbortSignal.timeout(10000),
      });
      const current = await response.json().catch(() => ({}));
      if (!response.ok) return res.status(502).json({ error: 'Could not verify payment status.' });
      if (current.orderId !== order.order_id || current.productId !== order.product_id || current.sessionId !== order.session_id
        || Number(current.amount) !== Number(order.amount_minor) || String(current.currency).toLowerCase() !== order.currency
        || (order.environment && current.environment !== order.environment)) {
        return res.status(409).json({ error: 'Payment details do not match this order.' });
      }
      await applyPaymentState(supabase, order, current, recordWalledPurchase);
      const status = current.status || order.status;
      if (status !== 'paid') return res.json({ status });
      return res.json({
        status,
        title: order.title,
        amount: Number(order.amount_minor) / 100,
        currency: String(order.currency || 'usd').toUpperCase(),
        telegram_username: typeof getTelegramUsername === 'function' ? await getTelegramUsername() : '',
      });
    } catch (error) {
      console.error('Walled status lookup failed:', error?.message || error);
      return res.status(500).json({ error: 'Could not verify payment status.' });
    }
  });

  app.post('/api/webhooks/walled', async (req, res) => {
    const c = config();
    if (!c.webhookSecret) return res.status(503).send('Webhook is not configured.');
    if (!signatureIsValid(req.rawBody, req.get('Walled-Signature'), c.webhookSecret)) return res.status(400).send('Invalid signature.');
    let event;
    try { event = JSON.parse(req.rawBody.toString('utf8')); } catch { return res.status(400).send('Invalid JSON.'); }
    if (!event?.id || !ALLOWED_EVENTS.has(event.type) || !event.data) return res.status(400).send('Invalid event.');
    const supabase = req.app.locals.getSupabase?.();
    if (!supabase) return res.status(503).send('Storage unavailable.');
    try {
      const { data: prior, error: priorError } = await supabase.from('walled_webhook_events').select('event_id, processed_at').eq('event_id', event.id).maybeSingle();
      if (priorError) throw priorError;
      if (prior?.processed_at) return res.sendStatus(200);
      if (!prior) {
        const { error } = await supabase.from('walled_webhook_events').insert({ event_id: event.id, event_type: event.type, payload: event });
        if (error && error.code !== '23505') throw error;
      }
      const data = event.data;
      const { data: order, error } = await supabase.from('walled_orders').select('*').eq('order_id', data.orderId).maybeSingle();
      if (error) throw error;
      if (!order || data.productId !== order.product_id || data.sessionId !== order.session_id || data.amount !== Number(order.amount_minor) || String(data.currency).toLowerCase() !== order.currency || !data.environment || (order.environment && data.environment !== order.environment)) {
        throw new Error('Walled event does not match a stored order.');
      }
      const statusResponse = await fetch(`${c.baseUrl}/checkout/sessions/${encodeURIComponent(order.session_id)}`, {
        headers: { Authorization: `Bearer ${c.apiKey}` }, signal: AbortSignal.timeout(10000),
      });
      const current = await statusResponse.json().catch(() => ({}));
      if (!statusResponse.ok) throw new Error(`Walled status reconciliation failed (${statusResponse.status}).`);
      await applyPaymentState(supabase, order, current, recordWalledPurchase);
      const { error: markError } = await supabase.from('walled_webhook_events').update({ processed_at: new Date().toISOString() }).eq('event_id', event.id);
      if (markError) throw markError;
      return res.sendStatus(200);
    } catch (error) {
      console.error('Walled webhook processing failed:', error?.message || error);
      return res.status(500).send('Event processing failed.');
    }
  });
}

async function applyPaymentState(supabase, order, payment, recordPurchase) {
  const statuses = new Set(['pending', 'failed', 'paid', 'expired', 'refunded', 'partially_refunded', 'disputed', 'dispute_lost']);
  const status = String(payment.status || '').toLowerCase();
  if (!statuses.has(status)) throw new Error('Unsupported Walled payment status.');
  if (payment.orderId !== order.order_id || payment.productId !== order.product_id || payment.sessionId !== order.session_id
    || Number(payment.amount) !== Number(order.amount_minor) || String(payment.currency).toLowerCase() !== order.currency
    || (order.environment && payment.environment !== order.environment)) {
    throw new Error('Walled payment status does not match the stored order.');
  }
  const terminal = new Set(['refunded', 'disputed', 'dispute_lost']);
  if (terminal.has(order.status) && status !== order.status) return;
  if (order.status === 'paid' && ['pending', 'failed', 'expired'].includes(status)) return;
  if (status === 'paid' && order.status !== 'paid') {
    if (typeof recordPurchase !== 'function') throw new Error('Walled purchase recorder is unavailable.');
    const result = await recordPurchase(payment, order);
    if (!result?.ok) throw new Error('Could not persist the confirmed Walled purchase.');
  }
  const { data: updated, error } = await supabase.from('walled_orders').update({
    status, walled_status: status, transaction_id: payment.transactionId || order.transaction_id,
  }).eq('order_id', order.order_id).eq('status', order.status).select('order_id').maybeSingle();
  if (error) throw error;
  if (!updated) {
    const { data: latest, error: reloadError } = await supabase.from('walled_orders').select('status').eq('order_id', order.order_id).maybeSingle();
    if (reloadError) throw reloadError;
    if (latest?.status === 'paid' && ['pending', 'failed', 'expired'].includes(status)) return;
    if (terminal.has(latest?.status)) return;
    throw new Error('Walled order changed while processing; retry reconciliation.');
  }
}
