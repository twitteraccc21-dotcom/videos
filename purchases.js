const recordedRefs = new Set();

const PAYMENT_METHODS = new Set(['whop', 'who', 'stripe', 'crypto', 'paypal', 'payjsr']);
const STATUSES = new Set(['pending', 'completed', 'failed', 'refunded']);

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function stripColumnFromPayload(fields, errorMessage) {
  const msg = String(errorMessage || '');
  const match = msg.match(/Could not find the '(\w+)' column/i)
    || msg.match(/column ["']?(\w+)["']? does not exist/i);
  if (!match || !(match[1] in fields)) return null;
  const next = { ...fields };
  delete next[match[1]];
  console.warn(`purchases column '${match[1]}' missing — retrying without it`);
  return next;
}

function cleanText(value, max = 200) {
  const s = String(value == null ? '' : value).trim();
  return s ? s.slice(0, max) : '';
}

function toAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function normalizePaymentMethod(raw) {
  const v = String(raw || '').toLowerCase().trim();
  if (PAYMENT_METHODS.has(v)) return v;
  if (v.includes('paypal')) return 'paypal';
  if (v.includes('payjsr')) return 'payjsr';
  if (v.includes('stripe')) return 'stripe';
  if (v.includes('crypto')) return 'crypto';
  if (v.includes('whop') || v === 'who') return 'whop';
  return 'payjsr';
}

function normalizeStatus(raw) {
  const v = String(raw || '').toLowerCase().trim();
  if (STATUSES.has(v)) return v;
  if (v === 'paid' || v === 'complete' || v === 'succeeded' || v === 'success') return 'completed';
  return 'completed';
}

function nestedEmail(obj) {
  if (!obj || typeof obj !== 'object') return '';
  return cleanText(
    obj.email_address
    || obj.email
    || obj.customer_email
    || obj.payer_email
    || obj.buyer_email
  );
}

function paypalPayer(order) {
  const payer = order?.payer || {};
  const given = payer.name?.given_name || '';
  const surname = payer.name?.surname || '';
  const shippingName = order?.purchase_units?.[0]?.shipping?.name?.full_name || '';
  return {
    buyer_email: nestedEmail(payer) || nestedEmail(order?.payment_source?.paypal),
    buyer_name: cleanText([given, surname].filter(Boolean).join(' ') || shippingName),
  };
}

function payjsrPayer(session) {
  const customer = session?.customer && typeof session.customer === 'object' ? session.customer : {};
  const billing = session?.billing && typeof session.billing === 'object' ? session.billing : {};
  const payer = session?.payer && typeof session.payer === 'object' ? session.payer : {};
  return {
    buyer_email: nestedEmail(session)
      || nestedEmail(customer)
      || nestedEmail(billing)
      || nestedEmail(payer)
      || nestedEmail(session?.metadata),
    buyer_name: cleanText(
      session?.customer_name
      || customer.name
      || customer.full_name
      || session?.name
      || billing.name
      || payer.name
      || ''
    ),
  };
}

function fallbackEmail(method, ref) {
  const safeRef = cleanText(ref, 80).replace(/[^a-z0-9._-]+/gi, '') || 'unknown';
  return `no-email+${safeRef}@${method}.local`;
}

export function createPurchaseRecorder(getSupabase) {
  async function findExisting(supabase, ref) {
    if (!ref) return null;
    const { data, error } = await supabase.from('purchases').select('id').eq('transaction_id', ref).maybeSingle();
    if (!error && data?.id) return data;
    return null;
  }

  function schemaFields(payload) {
    const method = normalizePaymentMethod(payload.payment_method);
    const ref = cleanText(payload.transaction_id, 120);
    const email = cleanText(payload.buyer_email, 320) || fallbackEmail(method, ref);
    const fields = {
      video_id: isUuid(payload.video_id) ? payload.video_id : null,
      buyer_email: email,
      buyer_name: cleanText(payload.buyer_name, 200) || null,
      transaction_id: ref,
      payment_method: method,
      amount: toAmount(payload.amount),
      currency: cleanText(payload.currency, 8).toLowerCase() || 'usd',
      status: normalizeStatus(payload.status),
      video_title: cleanText(payload.video_title, 240) || null,
      product_link: cleanText(payload.product_link, 2000) || null,
      metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : null,
    };
    Object.keys(fields).forEach((key) => {
      if (fields[key] === undefined) delete fields[key];
    });
    return fields;
  }

  async function insertPurchase(payload) {
    const supabase = typeof getSupabase === 'function' ? getSupabase() : null;
    if (!supabase) {
      console.warn('purchase not saved: Supabase is not configured');
      return { ok: false, error: 'Supabase not configured' };
    }

    let fields = schemaFields(payload);
    const ref = fields.transaction_id;
    if (!ref) {
      console.error('purchase insert failed: missing transaction_id');
      return { ok: false, error: 'missing transaction_id' };
    }
    if (recordedRefs.has(ref)) return { ok: true, duplicate: true };

    try {
      const existing = await findExisting(supabase, ref);
      if (existing) {
        recordedRefs.add(ref);
        return { ok: true, duplicate: true, id: existing.id };
      }
    } catch (err) {
      console.warn('purchase lookup failed:', err?.message || err);
    }

    for (let attempt = 0; attempt < 8; attempt++) {
      const { data, error } = await supabase.from('purchases').insert(fields).select('id').maybeSingle();
      if (!error) {
        recordedRefs.add(ref);
        return { ok: true, id: data?.id };
      }
      const code = String(error.code || '');
      if (code === '23505' || /duplicate|unique/i.test(error.message || '')) {
        recordedRefs.add(ref);
        return { ok: true, duplicate: true };
      }
      const stripped = stripColumnFromPayload(fields, error.message);
      if (!stripped) {
        console.error('purchase insert failed:', error.message);
        return { ok: false, error: error.message };
      }
      fields = stripped;
    }
    return { ok: false, error: 'Could not save purchase' };
  }

  async function recordPaypalPurchase(order, extras = {}) {
    const customId = String(
      extras.custom_id
      || order?.purchase_units?.[0]?.custom_id
      || ''
    );
    const videoId = customId.startsWith('video:') ? customId.slice('video:'.length) : null;
    const unit = order?.purchase_units?.[0];
    const capture = unit?.payments?.captures?.[0];
    const amount = extras.amount
      ?? capture?.amount?.value
      ?? unit?.amount?.value;
    const currency = extras.currency
      || capture?.amount?.currency_code
      || unit?.amount?.currency_code
      || 'USD';
    const payer = paypalPayer(order);
    const orderId = String(order?.id || extras.order_id || extras.transaction_id || '').trim();
    const title = extras.title
      || (customId === 'full-content-v1' ? 'Full Content' : unit?.description)
      || '';

    return insertPurchase({
      video_id: videoId,
      buyer_email: payer.buyer_email || extras.buyer_email,
      buyer_name: payer.buyer_name || extras.buyer_name,
      transaction_id: orderId,
      payment_method: 'paypal',
      amount,
      currency,
      status: 'completed',
      video_title: title,
      product_link: extras.product_link,
      metadata: {
        provider: 'paypal',
        paypal_order_id: orderId,
        custom_id: customId || null,
      },
    });
  }

  async function recordPayjsrPurchase(session, extras = {}) {
    const meta = session?.metadata && typeof session.metadata === 'object' ? session.metadata : {};
    const isBundle = String(meta.bundle || extras.bundle || '').toLowerCase() === 'all';
    const videoId = isBundle ? null : String(meta.video_id || extras.video_id || '').trim();
    const payer = payjsrPayer(session);
    const reference = String(session?.reference || extras.reference || extras.transaction_id || '').trim();
    const amount = extras.amount ?? session?.amount;
    const title = extras.title || meta.display_title || (isBundle ? 'All videos and folders' : '');

    return insertPurchase({
      video_id: videoId,
      buyer_email: payer.buyer_email || extras.buyer_email,
      buyer_name: payer.buyer_name || extras.buyer_name,
      transaction_id: reference,
      payment_method: 'payjsr',
      amount,
      currency: extras.currency || session?.currency || 'USD',
      status: 'completed',
      video_title: title,
      product_link: extras.product_link || meta.delivery_url,
      metadata: {
        provider: 'payjsr',
        reference,
        bundle: isBundle ? 'all' : null,
        session_status: session?.status || null,
      },
    });
  }

  async function listPurchases() {
    const supabase = typeof getSupabase === 'function' ? getSupabase() : null;
    if (!supabase) return [];

    const queries = [
      () => supabase.from('purchases').select('*, videos(id, title)').order('created_at', { ascending: false }).limit(300),
      () => supabase.from('purchases').select('*').order('created_at', { ascending: false }).limit(300),
      () => supabase.from('purchases').select('*').order('id', { ascending: false }).limit(300),
    ];

    let lastError = null;
    for (const query of queries) {
      const { data, error } = await query();
      if (!error) return data || [];
      lastError = error;
    }
    throw new Error(lastError?.message || 'Could not load purchases');
  }

  return {
    recordPaypalPurchase,
    recordPayjsrPurchase,
    listPurchases,
  };
}
