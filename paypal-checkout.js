import crypto from 'node:crypto';

const PAYPAL_API = {
  live: 'https://api-m.paypal.com',
  sandbox: 'https://api-m.sandbox.paypal.com',
};
const BUNDLE_PRICE = '150.00';

function paypalConfig() {
  const clientId = String(process.env.PAYPAL_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.PAYPAL_CLIENT_SECRET || '').trim();
  const mode = String(process.env.PAYPAL_ENVIRONMENT || 'live').trim().toLowerCase();
  return {
    clientId,
    clientSecret,
    baseUrl: mode === 'sandbox' ? PAYPAL_API.sandbox : PAYPAL_API.live,
    configured: Boolean(clientId && clientSecret),
  };
}

async function paypalRequest(path, options = {}) {
  const config = paypalConfig();
  if (!config.configured) throw new Error('PayPal is not configured. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.');

  const tokenResponse = await fetch(`${config.baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(12000),
  });
  const tokenPayload = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenPayload.access_token) {
    throw new Error('Could not authenticate with PayPal. Check the PayPal app credentials and environment.');
  }

  const response = await fetch(`${config.baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${tokenPayload.access_token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || 'PayPal could not process the request.');
    error.status = response.status;
    throw error;
  }
  return payload;
}

function getPurchaseUnit(order) {
  const purchaseUnit = Array.isArray(order?.purchase_units)
    ? order.purchase_units.find((unit) => unit.custom_id === 'full-content-v1' || /^video:.+/.test(String(unit.custom_id || '')))
    : null;
  const amount = Number(purchaseUnit?.amount?.value);
  if (!purchaseUnit || purchaseUnit.amount?.currency_code !== 'USD' || !Number.isFinite(amount) || amount <= 0) return null;
  if (purchaseUnit.custom_id === 'full-content-v1' && amount.toFixed(2) !== BUNDLE_PRICE) return null;
  const completedCapture = purchaseUnit.payments?.captures?.find((capture) => capture.status === 'COMPLETED');
  if (completedCapture && (
    completedCapture.amount?.currency_code !== 'USD' ||
    Number(completedCapture.amount?.value).toFixed(2) !== amount.toFixed(2)
  )) return null;
  return { purchaseUnit, amount, completedCapture };
}

export function registerPaypalRoutes(app, { getVideoForCheckout, getAllVideosForBundle, getTelegramUsername, recordPaypalPurchase }) {
  app.post('/api/paypal/orders', async (req, res) => {
    try {
      if (!paypalConfig().configured) {
        return res.status(503).json({ ok: false, error: 'PayPal is not configured. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.' });
      }
      const videoId = String(req.body?.video_id || '').trim();
      let purchaseUnit;
      if (videoId) {
        if (typeof getVideoForCheckout !== 'function') {
          return res.status(503).json({ ok: false, error: 'Video checkout is not configured.' });
        }
        const video = await getVideoForCheckout(videoId);
        if (!video || !video.is_active || video.is_free || !(Number(video.price) > 0)) {
          return res.status(404).json({ ok: false, error: 'This video is unavailable for purchase.' });
        }
        purchaseUnit = {
          custom_id: `video:${video.id}`,
          description: String(video.title || 'Video').slice(0, 127),
          amount: { currency_code: 'USD', value: Number(video.price).toFixed(2) },
        };
      } else {
        if (typeof getAllVideosForBundle !== 'function') {
          return res.status(503).json({ ok: false, error: 'The full-content offer is not configured.' });
        }
        const videos = await getAllVideosForBundle();
        if (!videos.some((video) => !video.is_free && Number(video.price) > 0)) {
          return res.status(404).json({ ok: false, error: 'The full-content offer is not available.' });
        }
        purchaseUnit = {
          custom_id: 'full-content-v1',
          description: 'Full Content — all content available on this site',
          amount: { currency_code: 'USD', value: BUNDLE_PRICE },
        };
      }

      const order = await paypalRequest('/v2/checkout/orders', {
        method: 'POST',
        headers: { 'PayPal-Request-Id': crypto.randomUUID() },
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: [purchaseUnit],
        }),
      });
      if (!order.id || order.status !== 'CREATED') {
        return res.status(502).json({ ok: false, error: 'PayPal did not create the payment order.' });
      }
      res.json({ ok: true, id: order.id });
    } catch (error) {
      console.error('PayPal order creation failed:', error.message);
      res.status(error.status === 422 ? 422 : 502).json({ ok: false, error: error.message || 'Could not start PayPal checkout.' });
    }
  });

  app.post('/api/paypal/orders/:orderId/capture', async (req, res) => {
    try {
      const orderId = String(req.params.orderId || '').trim();
      if (!/^[A-Z0-9-]{8,80}$/i.test(orderId)) {
        return res.status(400).json({ ok: false, error: 'Invalid PayPal order ID.' });
      }
      const orderBeforeCapture = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, { method: 'GET' });
      if (orderBeforeCapture.status !== 'APPROVED' || !getPurchaseUnit(orderBeforeCapture)) {
        return res.status(400).json({ ok: false, error: 'This PayPal order is not an approved purchase.' });
      }
      const capture = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
        method: 'POST',
        headers: { 'PayPal-Request-Id': `capture-${orderId}` },
        body: '{}',
      });
      if (capture.status !== 'COMPLETED') {
        return res.status(402).json({ ok: false, error: 'PayPal has not completed this payment.' });
      }
      if (typeof recordPaypalPurchase === 'function') {
        try {
          await recordPaypalPurchase(capture);
        } catch (saveError) {
          console.error('PayPal purchase save failed:', saveError.message);
        }
      }
      res.json({ ok: true });
    } catch (error) {
      console.error('PayPal capture failed:', error.message);
      res.status(error.status === 422 ? 422 : 502).json({ ok: false, error: error.message || 'Could not capture PayPal payment.' });
    }
  });

  app.get('/api/paypal/success', async (req, res) => {
    try {
      const orderId = String(req.query.order_id || '').trim();
      if (!/^[A-Z0-9-]{8,80}$/i.test(orderId)) {
        return res.status(400).json({ ok: false, error: 'Invalid PayPal order ID.' });
      }
      const order = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, { method: 'GET' });
      const verified = getPurchaseUnit(order);
      if (order.status !== 'COMPLETED' || !verified?.completedCapture) {
        return res.status(402).json({ ok: false, pending: true, error: 'PayPal payment is not confirmed yet.' });
      }
      let title = verified.purchaseUnit.description || 'Your purchase';
      let productLink = '';
      if (verified.purchaseUnit.custom_id === 'full-content-v1') {
        title = 'Full Content';
      } else {
        const videoId = verified.purchaseUnit.custom_id.slice('video:'.length);
        const video = typeof getVideoForCheckout === 'function' ? await getVideoForCheckout(videoId) : null;
        if (video) {
          title = video.title || title;
          const currentPriceMatches = Number(video.price).toFixed(2) === Number(verified.amount).toFixed(2);
          if (video.is_active && !video.is_free && currentPriceMatches) {
            const candidateLink = String(video.product_link || '').trim();
            if (/^https?:\/\//i.test(candidateLink)) productLink = candidateLink;
          }
        }
      }
      if (typeof recordPaypalPurchase === 'function') {
        try {
          await recordPaypalPurchase(order, {
            title,
            amount: verified.completedCapture.amount.value,
            currency: verified.completedCapture.amount.currency_code,
            product_link: productLink,
          });
        } catch (saveError) {
          console.error('PayPal purchase save failed:', saveError.message);
        }
      }
      res.json({
        ok: true,
        title,
        amount: verified.completedCapture.amount.value,
        currency: verified.completedCapture.amount.currency_code,
        product_link: productLink,
        delivery_via_telegram: !productLink,
        telegram_username: typeof getTelegramUsername === 'function' ? await getTelegramUsername() : '',
      });
    } catch (error) {
      console.error('PayPal payment verification failed:', error.message);
      res.status(502).json({ ok: false, error: error.message || 'Could not verify PayPal payment.' });
    }
  });
}
