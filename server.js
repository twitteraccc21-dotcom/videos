import 'dotenv/config';
import express from 'express';
import path from 'path';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { registerPayjsrRoutes } from './payjsr-checkout.js';
import { registerPaypalRoutes } from './paypal-checkout.js';
import { createPurchaseRecorder } from './purchases.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3002;
const SITE_NAME = process.env.SITE_NAME || 'Video Vault';

const ebooksEnv =
  process.env.EBOOKS_SITE_URL ||
  process.env.VITE_CHECKOUT_URL ||
  process.env.VITE_PAYMENT_URL ||
  '';
const EBOOKS_SITE_URL = String(ebooksEnv || '').replace(/\/+$/, '');
const TELEGRAM_USERNAME =
  process.env.TELEGRAM_USERNAME ||
  process.env.VITE_TELEGRAM_USERNAME ||
  '';
const PAYPAL_CLIENT_ID = trimEnv('PAYPAL_CLIENT_ID');
const PAYPAL_CHECKOUT_CONFIGURED = Boolean(PAYPAL_CLIENT_ID && trimEnv('PAYPAL_CLIENT_SECRET'));

function escapeJsString(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/</g, '\\x3c')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

const supabaseUrl =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  process.env.VITE_PROJECT_URL ||
  '';

const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  '';

function trimEnv(...keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

function wasabiSecretFromEnv() {
  const c = {
    accessKey: trimEnv('WASABI_ACCESS_KEY', 'VITE_WASABI_ACCESS_KEY'),
    secretKey: trimEnv('WASABI_SECRET_KEY', 'VITE_WASABI_SECRET_KEY'),
    region: trimEnv('WASABI_REGION', 'VITE_WASABI_REGION'),
    bucket: trimEnv('WASABI_BUCKET', 'VITE_WASABI_BUCKET'),
    endpoint: trimEnv('WASABI_ENDPOINT', 'VITE_WASABI_ENDPOINT').replace(/\/+$/, ''),
  };
  const signingReady = Boolean(
    c.accessKey && c.secretKey && c.bucket && c.region && c.endpoint
  );
  return { ...c, signingReady };
}

function normalizeWasabiConfigRow(wc) {
  if (!wc || typeof wc !== 'object') return null;
  const c = {
    accessKey: String(wc.accessKey || wc.access_key || '').trim(),
    secretKey: String(wc.secretKey || wc.secret_key || '').trim(),
    region: String(wc.region || '').trim(),
    bucket: String(wc.bucket || '').trim(),
    endpoint: String(wc.endpoint || '').replace(/\/+$/, ''),
  };
  const signingReady = Boolean(
    c.accessKey && c.secretKey && c.bucket && c.region && c.endpoint
  );
  return { ...c, signingReady };
}

let supabaseWasabiCache = null;
let supabaseWasabiCacheAt = 0;
const WASABI_CACHE_MS = 120_000;

async function resolveWasabiSigningConfig() {
  const fromEnv = wasabiSecretFromEnv();
  if (fromEnv.signingReady) return fromEnv;

  const now = Date.now();
  if (supabaseWasabiCache && now - supabaseWasabiCacheAt < WASABI_CACHE_MS) {
    return supabaseWasabiCache;
  }

  let merged = { ...fromEnv, signingReady: false };
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('site_config')
        .select('wasabi_config')
        .limit(1)
        .maybeSingle();
      if (!error && data?.wasabi_config) {
        const fromDb = normalizeWasabiConfigRow(data.wasabi_config);
        if (fromDb?.signingReady) {
          merged = fromDb;
        } else if (fromDb && fromEnv.accessKey && fromEnv.secretKey) {
          merged = {
            accessKey: fromEnv.accessKey,
            secretKey: fromEnv.secretKey,
            region: fromDb.region || fromEnv.region,
            bucket: fromDb.bucket || fromEnv.bucket,
            endpoint: (fromDb.endpoint || fromEnv.endpoint || '').replace(/\/+$/, ''),
            signingReady: Boolean(
              fromEnv.accessKey &&
                fromEnv.secretKey &&
                (fromDb.bucket || fromEnv.bucket) &&
                (fromDb.region || fromEnv.region) &&
                (fromDb.endpoint || fromEnv.endpoint)
            ),
          };
        }
      }
    } catch (e) {
      console.warn('Wasabi site_config read failed:', e.message);
    }
  }

  supabaseWasabiCache = merged;
  supabaseWasabiCacheAt = now;
  return merged;
}

function isHttpUrl(val) {
  const s = String(val || '').trim();
  return /^https?:\/\//i.test(s);
}

/** Same shape as main app: site_config.crypto jsonb array of "SYMBOL:address" strings or objects. */
function normalizeCryptoWalletEntry(entry) {
  if (entry == null) return null;
  if (typeof entry === 'string') {
    const s = entry.trim();
    if (!s) return null;
    const idx = s.indexOf(':');
    if (idx <= 0) {
      return { symbol: 'CRYPTO', address: s, label: 'Wallet' };
    }
    const symbol = s.slice(0, idx).trim() || 'CRYPTO';
    const address = s.slice(idx + 1).trim();
    if (!address) return null;
    return { symbol, address, label: symbol.toUpperCase() };
  }
  if (typeof entry === 'object') {
    const symbol = String(entry.symbol || entry.coin || entry.currency || '').trim() || 'CRYPTO';
    const address = String(entry.address || entry.addr || '').trim();
    if (!address) return null;
    const label = String(entry.label || entry.network || symbol).trim() || symbol.toUpperCase();
    return { symbol, address, label };
  }
  return null;
}

function normalizeCryptoList(raw) {
  if (raw == null) return [];
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeCryptoWalletEntry).filter(Boolean);
}

function mergeCryptoDedup(a, b) {
  const seen = new Set();
  const out = [];
  for (const list of [a, b]) {
    for (const w of list) {
      const key = `${String(w.address)}|${String(w.symbol || '')}`;
      if (!w.address || seen.has(key)) continue;
      seen.add(key);
      out.push(w);
    }
  }
  return out;
}

function sortSources(list) {
  if (!Array.isArray(list)) return [];
  return [...list].sort((a, b) => (Number(a?.position ?? 0) || 0) - (Number(b?.position ?? 0) || 0));
}

/**
 * Keys for signing only. Do NOT put path-style public URLs here — private buckets return 403 in <img>/<video>.
 */
function enrichVideoRow(row) {
  const sortedSources = sortSources(row.video_sources);
  const primarySource = sortedSources[0];

  const vk = row.video_file_id || primarySource?.source_file_id || null;
  const wasabi_video_key = vk ? String(vk).trim() : null;
  const posterAt = Number(row.poster_at);
  const poster_at = Number.isFinite(posterAt) && posterAt >= 0 ? posterAt : 1;

  return {
    ...row,
    video_sources: sortedSources,
    /** Only explicit public URLs stored in DB */
    playback_url:
      row.public_video_url && isHttpUrl(row.public_video_url)
        ? String(row.public_video_url).trim()
        : '',
    wasabi_video_key,
    poster_at,
  };
}

async function signingClientAndBucket() {
  const cfg = await resolveWasabiSigningConfig();
  if (!cfg.signingReady) return { cfg, client: null };
  const client = new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    credentials: {
      accessKeyId: cfg.accessKey,
      secretAccessKey: cfg.secretKey,
    },
    forcePathStyle: true,
  });
  return { cfg, client };
}

function sanitizeObjectKey(raw) {
  try {
    if (typeof raw !== 'string') raw = String(raw || '');
    raw = decodeURIComponent(raw.trim());
  } catch {
    raw = String(raw || '').trim();
  }
  if (!raw || raw.startsWith('metadata/')) return null;
  return raw;
}

app.use(express.json());
const purchaseRecorder = createPurchaseRecorder(() => supabase);
registerPayjsrRoutes(app, {
  siteName: SITE_NAME,
  recordPayjsrPurchase: purchaseRecorder.recordPayjsrPurchase,
  getVideoForCheckout: async (id) => {
    if (!supabase) return null;
    const { data, error } = await supabase
      .from('videos')
      .select('id, title, price, is_free, is_active, product_link')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    return data;
  },
  getAllVideosForBundle: async () => {
    if (!supabase) return [];
    const { data, error } = await supabase
      .from('videos')
      .select('id, title, price, is_free, is_active, product_link')
      .eq('is_active', true)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  },
  getTelegramUsername: resolveTelegramUsername,
});

registerPaypalRoutes(app, {
  recordPaypalPurchase: purchaseRecorder.recordPaypalPurchase,
  getVideoForCheckout: async (id) => {
    if (!supabase) return null;
    const { data, error } = await supabase
      .from('videos')
      .select('id, title, price, is_free, is_active, product_link')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    return data;
  },
  getAllVideosForBundle: async () => {
    if (!supabase) return [];
    const { data, error } = await supabase
      .from('videos')
      .select('id, title, price, is_free, is_active, product_link')
      .eq('is_active', true)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  },
  getTelegramUsername: resolveTelegramUsername,
});

const SESSION_COOKIE = 'vv_admin';
const SESSION_DAYS = 7;

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

function setSessionCookie(res, token) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
  );
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(String(password)).digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function sanitizeFilename(name) {
  return String(name || 'file')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 120) || 'file';
}

function buildUploadKey(videoId, filename) {
  const id = videoId || crypto.randomUUID();
  return `videos/${id}/${Date.now()}_${sanitizeFilename(filename)}`;
}

const VIDEO_EDIT_FIELDS = [
  'title',
  'description',
  'price',
  'duration',
  'video_file_id',
  'public_video_url',
  'poster_at',
  'product_link',
  'is_active',
  'is_free',
  'sort_order',
];

function pickVideoFields(body) {
  const out = {};
  for (const key of VIDEO_EDIT_FIELDS) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  if (out.price != null) out.price = Number(out.price) || 0;
  if (out.sort_order != null) out.sort_order = Number(out.sort_order) || 0;
  if (out.poster_at != null) {
    const n = Number(out.poster_at);
    out.poster_at = Number.isFinite(n) && n >= 0 ? n : 1;
  }
  if (typeof out.is_active === 'string') out.is_active = out.is_active === 'true';
  if (typeof out.is_free === 'string') out.is_free = out.is_free === 'true';
  return out;
}

/** Supabase schema cache errors when a column was never migrated — drop and retry. */
function stripColumnFromPayload(fields, errorMessage) {
  const msg = String(errorMessage || '');
  const match = msg.match(/Could not find the '(\w+)' column/i);
  if (!match || !(match[1] in fields)) return null;
  const next = { ...fields };
  delete next[match[1]];
  console.warn(`videos column '${match[1]}' missing in DB — retrying without it (run db/supabase migration)`);
  return next;
}

async function videoDbWrite(writeFn, payload) {
  let fields = { ...payload };
  for (let attempt = 0; attempt < 8; attempt++) {
    const result = await writeFn(fields);
    if (!result.error) return result;
    const stripped = stripColumnFromPayload(fields, result.error.message);
    if (!stripped) return result;
    fields = stripped;
  }
  return { data: null, error: { message: 'Falha ao gravar vídeo (schema desatualizado)' } };
}

async function requireAdmin(req, res, next) {
  try {
    if (!supabase) return res.status(503).json({ error: 'Supabase não configurado' });
    const token = parseCookies(req)[SESSION_COOKIE];
    if (!token) return res.status(401).json({ error: 'Não autenticado' });

    const { data: session, error } = await supabase
      .from('sessions')
      .select('id, user_id, expires_at, is_active, users(id, email, name, role)')
      .eq('token', token)
      .eq('is_active', true)
      .maybeSingle();

    if (error || !session || new Date(session.expires_at) < new Date()) {
      return res.status(401).json({ error: 'Sessão inválida ou expirada' });
    }

    req.adminUser = session.users;
    req.adminSessionId = session.id;
    next();
  } catch (e) {
    console.error('requireAdmin:', e);
    res.status(500).json({ error: 'Erro de autenticação' });
  }
}

async function fetchAdminVideo(id) {
  const joined = await supabase
    .from('videos')
    .select('*, video_sources(*)')
    .eq('id', id)
    .maybeSingle();

  if (joined.error && /relationship|foreign|video_sources|schema cache/i.test(String(joined.error.message || ''))) {
    const fb = await supabase.from('videos').select('*').eq('id', id).maybeSingle();
    return fb;
  }
  return joined;
}

let supabase;
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

app.get('/api/health', async (req, res) => {
  const w = await resolveWasabiSigningConfig();
  res.json({
    status: 'OK',
    site: SITE_NAME,
    supabase: Boolean(supabase),
    ebooks_checkout_origin: Boolean(EBOOKS_SITE_URL),
    payjsr_configured: Boolean(trimEnv('PAYJSR_SECRET_KEY', 'PAYJSR_API_KEY')),
    paypal_configured: Boolean(trimEnv('PAYPAL_CLIENT_ID') && trimEnv('PAYPAL_CLIENT_SECRET')),
    telegram: Boolean(String(TELEGRAM_USERNAME || '').trim()),
    wasabi_signed_urls: Boolean(w.signingReady),
    wasabi_from_env: Boolean(wasabiSecretFromEnv().signingReady),
  });
});

async function handleSignedUrlRequest(req, res) {
  try {
    let fileId = req.params.fileId;
    if (!fileId && req.query.key != null) {
      fileId = Array.isArray(req.query.key) ? req.query.key[0] : req.query.key;
    }
    fileId = sanitizeObjectKey(fileId);
    if (!fileId) {
      return res.status(400).json({ error: 'Missing or invalid object key (use ?key=... or path).' });
    }

    const { cfg, client } = await signingClientAndBucket();
    if (!client || !cfg.signingReady) {
      return res.status(503).json({
        error:
          'Wasabi signing not configured. Set WASABI_* or VITE_WASABI_* env vars on this service, or store full wasabi_config in Supabase site_config.',
      });
    }

    const command = new GetObjectCommand({
      Bucket: cfg.bucket,
      Key: fileId,
    });
    const url = await getSignedUrl(client, command, { expiresIn: 3600 });
    res.json({ success: true, url, expiresIn: 3600 });
  } catch (error) {
    console.error('signed-url error:', error.name, error.message);
    res.status(500).json({
      error: 'Failed to generate signed URL',
      details: error.message,
      code: error.name || '',
    });
  }
}

/** Prefer ?key=... — safe for keys that contain slashes (Express path params vary). */
app.get('/api/signed-url', handleSignedUrlRequest);
app.get('/api/signed-url/:fileId', handleSignedUrlRequest);

app.get('/api/video-ids', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
    const { data, error } = await supabase
      .from('videos')
      .select('id')
      .eq('is_active', true)
      .order('created_at', { ascending: false });
    if (error) return res.status(502).json({ error: error.message });
    res.json({ ids: (data || []).map((r) => r.id).filter(Boolean) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to list ids' });
  }
});

/** Telegram username: Supabase site_config first, then env (videos-site). */
function normalizeTelegramUsername(raw) {
  return String(raw || '').replace(/^@/, '').trim();
}

async function resolveTelegramUsername() {
  let telegram = TELEGRAM_USERNAME;
  if (supabase) {
    try {
      const { data } = await supabase
        .from('site_config')
        .select('telegram_username')
        .limit(1)
        .maybeSingle();
      if (data?.telegram_username) telegram = data.telegram_username;
    } catch (e) {
      console.warn('site_config telegram_username read failed:', e.message);
    }
  }
  return normalizeTelegramUsername(telegram);
}

async function getSiteConfigRow() {
  const { data, error } = await supabase
    .from('site_config')
    .select('id, telegram_username, crypto')
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function upsertSiteConfigFields(fields) {
  const existing = await getSiteConfigRow();
  const payload = { ...fields, updated_at: new Date().toISOString() };
  if (existing?.id) {
    return supabase.from('site_config').update(payload).eq('id', existing.id).select('telegram_username, crypto').single();
  }
  return supabase.from('site_config').insert(payload).select('telegram_username, crypto').single();
}

async function upsertTelegramUsername(username) {
  const clean = normalizeTelegramUsername(username);
  return upsertSiteConfigFields({ telegram_username: clean || null });
}

function prepareCryptoForDb(wallets) {
  if (!Array.isArray(wallets)) return [];
  return wallets
    .map((w) => normalizeCryptoWalletEntry(w))
    .filter(Boolean)
    .map((w) => ({ symbol: w.symbol, address: w.address, label: w.label }));
}

app.get('/api/site-brief', async (req, res) => {
  try {
    let videoListTitle = trimEnv('VIDEO_LIST_TITLE', 'VITE_VIDEO_LIST_TITLE');
    let telegram = await resolveTelegramUsername();
    let cryptoFromDb = [];
    if (supabase) {
      const { data } = await supabase
        .from('site_config')
        .select('video_list_title, telegram_username, crypto')
        .limit(1)
        .maybeSingle();
      if (data?.video_list_title) videoListTitle = data.video_list_title;
      if (data?.telegram_username) telegram = String(data.telegram_username).replace(/^@/, '').trim();
      cryptoFromDb = normalizeCryptoList(data?.crypto);
    }
    const cryptoFromEnv = normalizeCryptoList(trimEnv('CRYPTO_WALLETS_JSON', 'VITE_CRYPTO_WALLETS_JSON'));
    const crypto_wallets = mergeCryptoDedup(cryptoFromDb, cryptoFromEnv);
    res.json({
      video_list_title: videoListTitle || '',
      telegram_username: (telegram || '').replace(/^@/, ''),
      crypto_wallets,
    });
  } catch {
    const crypto_wallets = normalizeCryptoList(trimEnv('CRYPTO_WALLETS_JSON', 'VITE_CRYPTO_WALLETS_JSON'));
    res.json({
      video_list_title: '',
      telegram_username: (TELEGRAM_USERNAME || '').replace(/^@/, ''),
      crypto_wallets,
    });
  }
});

app.post('/api/videos/:id/views', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
    const id = req.params.id;
    const { error: rpcErr } = await supabase.rpc('increment', {
      table_name: 'videos',
      row_id: id,
      column_name: 'views',
    });
    if (rpcErr) {
      const { data: current } = await supabase.from('videos').select('views').eq('id', id).maybeSingle();
      await supabase
        .from('videos')
        .update({ views: (current?.views || 0) + 1 })
        .eq('id', id);
    }
    const { data: row } = await supabase.from('videos').select('views').eq('id', id).maybeSingle();
    res.json({ views: row?.views ?? 0 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to increment views' });
  }
});

app.get('/api/videos/:id', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({
        error: 'Supabase not configured (set SUPABASE_URL / VITE_SUPABASE_URL plus anon or service role key).',
      });
    }

    const id = req.params.id;
    const joined = await supabase
      .from('videos')
      .select('*, video_sources(*)')
      .eq('id', id)
      .eq('is_active', true)
      .maybeSingle();

    let row = joined.data;
    if (joined.error && /relationship|foreign|video_sources|schema cache/i.test(String(joined.error.message || ''))) {
      const fb = await supabase.from('videos').select('*').eq('id', id).eq('is_active', true).maybeSingle();
      if (fb.error) {
        return res.status(502).json({ error: fb.error.message || 'Database error' });
      }
      row = fb.data;
    } else if (joined.error) {
      return res.status(502).json({ error: joined.error.message || 'Database error' });
    }

    if (!row) return res.status(404).json({ error: 'Video not found' });

    const w = await resolveWasabiSigningConfig();
    const payload = {
      ...enrichVideoRow(row),
      wasabi_signing_ready: Boolean(w.signingReady),
    };

    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({ video: payload });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load video' });
  }
});

app.get('/api/videos', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({
        error: 'Supabase not configured (set SUPABASE_URL / VITE_SUPABASE_URL plus anon or service role key).',
      });
    }

    const baseQuery = () => supabase.from('videos').select('*').eq('is_active', true);

    let rows = [];

    const joined = await supabase
      .from('videos')
      .select('*, video_sources(*)')
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (joined.error && /relationship|foreign|video_sources|schema cache/i.test(String(joined.error.message || ''))) {
      const fb = await baseQuery().order('created_at', { ascending: false });
      if (fb.error) {
        console.error('Supabase videos error:', fb.error);
        return res.status(502).json({ error: fb.error.message || 'Database error' });
      }
      rows = fb.data || [];
    } else if (joined.error) {
      console.error('Supabase videos error:', joined.error);
      return res.status(502).json({ error: joined.error.message || 'Database error' });
    } else {
      rows = joined.data || [];
    }

    rows.sort((a, b) => {
      const sa = Number(a?.sort_order);
      const sb = Number(b?.sort_order);
      if (Number.isFinite(sa) && Number.isFinite(sb) && sa !== sb) return sa - sb;
      if (Number.isFinite(sa) && !Number.isFinite(sb)) return -1;
      if (!Number.isFinite(sa) && Number.isFinite(sb)) return 1;
      return new Date(b?.created_at || 0) - new Date(a?.created_at || 0);
    });

    const w = await resolveWasabiSigningConfig();
    const payload = rows.map(enrichVideoRow).map((r) => ({
      ...r,
      wasabi_signing_ready: Boolean(w.signingReady),
    }));

    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({ videos: payload });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load videos' });
  }
});

async function renderHtmlTemplate(fileName) {
  const telegram = await resolveTelegramUsername();
  const html = readFileSync(path.join(__dirname, 'public', fileName), 'utf8');
  return html
    .replace(/\{\{SITE_NAME\}\}/g, SITE_NAME)
    .replace(/\{\{TELEGRAM_USERNAME\}\}/g, telegram)
    .replace(/\{\{EBOOKS_SITE_URL\}\}/g, EBOOKS_SITE_URL)
    .replace(/\{\{PAYPAL_CLIENT_ID\}\}/g, escapeJsString(PAYPAL_CLIENT_ID))
    .replace(/\{\{PAYPAL_ENABLED\}\}/g, PAYPAL_CHECKOUT_CONFIGURED ? 'true' : 'false');
}

app.get('/', async (req, res) => {
  try {
    res.type('html').send(await renderHtmlTemplate('index.html'));
  } catch {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

app.get('/watch/:id', (req, res) => {
  res.redirect(302, `/watch?id=${encodeURIComponent(req.params.id)}`);
});

app.get('/watch', async (req, res) => {
  try {
    res.type('html').send(await renderHtmlTemplate('watch.html'));
  } catch {
    res.sendFile(path.join(__dirname, 'public', 'watch.html'));
  }
});

// ─── Admin API ───────────────────────────────────────────────────────────────

app.post('/api/admin/login', async (req, res) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'Supabase não configurado' });

    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) {
      return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, name, role, password_hash')
      .eq('email', email)
      .maybeSingle();

    if (error || !user || user.password_hash !== hashPassword(password)) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    const token = generateToken();
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);

    const { error: sessErr } = await supabase.from('sessions').insert({
      user_id: user.id,
      token,
      user_agent: String(req.headers['user-agent'] || '').slice(0, 500),
      expires_at: expiresAt.toISOString(),
    });

    if (sessErr) {
      console.error('session insert:', sessErr);
      return res.status(500).json({ error: 'Falha ao criar sessão' });
    }

    setSessionCookie(res, token);
    res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (e) {
    console.error('admin login:', e);
    res.status(500).json({ error: 'Erro no login' });
  }
});

app.post('/api/admin/logout', requireAdmin, async (req, res) => {
  try {
    if (req.adminSessionId) {
      await supabase.from('sessions').update({ is_active: false }).eq('id', req.adminSessionId);
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (e) {
    clearSessionCookie(res);
    res.json({ ok: true });
  }
});

app.get('/api/admin/me', requireAdmin, (req, res) => {
  res.json({ user: req.adminUser });
});

app.get('/api/admin/purchases', requireAdmin, async (req, res) => {
  try {
    const purchases = await purchaseRecorder.listPurchases();
    res.json({ purchases });
  } catch (e) {
    console.error('admin purchases:', e);
    res.status(500).json({ error: e.message || 'Falha ao carregar pagamentos' });
  }
});

app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const envFallback = normalizeTelegramUsername(TELEGRAM_USERNAME);
    const cryptoFromEnv = normalizeCryptoList(trimEnv('CRYPTO_WALLETS_JSON', 'VITE_CRYPTO_WALLETS_JSON'));
    let dbUsername = '';
    let cryptoFromDb = [];
    if (supabase) {
      const row = await getSiteConfigRow();
      dbUsername = normalizeTelegramUsername(row?.telegram_username);
      cryptoFromDb = normalizeCryptoList(row?.crypto);
    }
    const effective = dbUsername || envFallback;
    res.json({
      telegram_username: dbUsername,
      telegram_from_env: envFallback,
      telegram_effective: effective,
      crypto_wallets: cryptoFromDb,
      crypto_from_env: cryptoFromEnv,
      crypto_effective: mergeCryptoDedup(cryptoFromDb, cryptoFromEnv),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Falha ao carregar definições' });
  }
});

app.patch('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const hasTelegram = req.body?.telegram_username !== undefined;
    const hasCrypto = req.body?.crypto_wallets !== undefined;
    if (!hasTelegram && !hasCrypto) {
      return res.status(400).json({ error: 'Nada para atualizar' });
    }

    const patch = {};
    if (hasTelegram) patch.telegram_username = normalizeTelegramUsername(req.body.telegram_username) || null;
    if (hasCrypto) patch.crypto = prepareCryptoForDb(req.body.crypto_wallets);

    const { data, error } = await upsertSiteConfigFields(patch);
    if (error) return res.status(502).json({ error: error.message });

    const cryptoFromDb = normalizeCryptoList(data?.crypto);
    const cryptoFromEnv = normalizeCryptoList(trimEnv('CRYPTO_WALLETS_JSON', 'VITE_CRYPTO_WALLETS_JSON'));
    const savedTelegram = normalizeTelegramUsername(data?.telegram_username);

    res.json({
      ok: true,
      telegram_username: savedTelegram,
      telegram_effective: savedTelegram || normalizeTelegramUsername(TELEGRAM_USERNAME),
      crypto_wallets: cryptoFromDb,
      crypto_effective: mergeCryptoDedup(cryptoFromDb, cryptoFromEnv),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Falha ao guardar definições' });
  }
});

app.patch('/api/admin/account', requireAdmin, async (req, res) => {
  try {
    const currentPassword = String(req.body?.current_password || '');
    const newEmail = req.body?.email != null ? String(req.body.email).trim().toLowerCase() : null;
    const newPassword = req.body?.new_password != null ? String(req.body.new_password) : null;

    if (!currentPassword) {
      return res.status(400).json({ error: 'Senha atual é obrigatória' });
    }
    if (!newEmail && !newPassword) {
      return res.status(400).json({ error: 'Indique novo email e/ou nova senha' });
    }

    const userId = req.adminUser?.id;
    if (!userId) return res.status(401).json({ error: 'Sessão inválida' });

    const { data: user, error: fetchErr } = await supabase
      .from('users')
      .select('id, email, name, role, password_hash')
      .eq('id', userId)
      .maybeSingle();

    if (fetchErr || !user) return res.status(502).json({ error: 'Utilizador não encontrado' });
    if (user.password_hash !== hashPassword(currentPassword)) {
      return res.status(401).json({ error: 'Senha atual incorreta' });
    }

    const updates = {};
    if (newEmail && newEmail !== user.email) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
        return res.status(400).json({ error: 'Email inválido' });
      }
      const { data: taken } = await supabase
        .from('users')
        .select('id')
        .eq('email', newEmail)
        .neq('id', userId)
        .maybeSingle();
      if (taken) return res.status(409).json({ error: 'Email já em uso' });
      updates.email = newEmail;
    }
    if (newPassword) {
      if (newPassword.length < 6) {
        return res.status(400).json({ error: 'Nova senha deve ter pelo menos 6 caracteres' });
      }
      updates.password_hash = hashPassword(newPassword);
    }

    if (!Object.keys(updates).length) {
      return res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
    }

    const { data: updated, error: updErr } = await supabase
      .from('users')
      .update(updates)
      .eq('id', userId)
      .select('id, email, name, role')
      .single();

    if (updErr) return res.status(502).json({ error: updErr.message });
    res.json({ ok: true, user: updated });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Falha ao atualizar conta' });
  }
});

app.get('/api/admin/videos', requireAdmin, async (req, res) => {
  try {
    const joined = await supabase
      .from('videos')
      .select('*, video_sources(*)')
      .order('created_at', { ascending: false });

    let rows = joined.data || [];
    if (joined.error && /relationship|foreign|video_sources|schema cache/i.test(String(joined.error.message || ''))) {
      const fb = await supabase.from('videos').select('*').order('created_at', { ascending: false });
      if (fb.error) return res.status(502).json({ error: fb.error.message });
      rows = fb.data || [];
    } else if (joined.error) {
      return res.status(502).json({ error: joined.error.message });
    }

    rows.sort((a, b) => {
      const sa = Number(a?.sort_order);
      const sb = Number(b?.sort_order);
      if (Number.isFinite(sa) && Number.isFinite(sb) && sa !== sb) return sa - sb;
      return new Date(b?.created_at || 0) - new Date(a?.created_at || 0);
    });

    res.json({ videos: rows.map(enrichVideoRow) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Falha ao listar vídeos' });
  }
});

app.get('/api/admin/videos/:id', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await fetchAdminVideo(req.params.id);
    if (error) return res.status(502).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Vídeo não encontrado' });
    res.json({ video: enrichVideoRow(data) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Falha ao carregar vídeo' });
  }
});

app.post('/api/admin/videos', requireAdmin, async (req, res) => {
  try {
    const fields = pickVideoFields(req.body);
    if (!fields.title || !String(fields.title).trim()) {
      return res.status(400).json({ error: 'Título é obrigatório' });
    }

    const insert = {
      title: String(fields.title).trim(),
      description: fields.description ?? '',
      price: fields.price ?? 0,
      duration: fields.duration ?? '',
      video_file_id: fields.video_file_id ?? null,
      public_video_url: fields.public_video_url ?? null,
      poster_at: fields.poster_at ?? 1,
      product_link: fields.product_link ?? null,
      is_active: fields.is_active ?? true,
      is_free: fields.is_free ?? false,
      sort_order: fields.sort_order ?? 0,
    };

    const { data, error } = await videoDbWrite(
      (fields) => supabase.from('videos').insert(fields).select('*').single(),
      insert
    );
    if (error) return res.status(502).json({ error: error.message });
    res.status(201).json({ video: enrichVideoRow(data) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Falha ao criar vídeo' });
  }
});

app.patch('/api/admin/videos/:id', requireAdmin, async (req, res) => {
  try {
    const fields = pickVideoFields(req.body);
    if (fields.title != null && !String(fields.title).trim()) {
      return res.status(400).json({ error: 'Título não pode ser vazio' });
    }
    if (fields.title != null) fields.title = String(fields.title).trim();

    const { data, error } = await videoDbWrite(
      (fields) =>
        supabase.from('videos').update(fields).eq('id', req.params.id).select('*').maybeSingle(),
      fields
    );

    if (error) return res.status(502).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Vídeo não encontrado' });
    res.json({ video: enrichVideoRow(data) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Falha ao atualizar vídeo' });
  }
});

app.delete('/api/admin/videos/:id', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('videos')
      .update({ is_active: false })
      .eq('id', req.params.id)
      .select('id')
      .maybeSingle();

    if (error) return res.status(502).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Vídeo não encontrado' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Falha ao desativar vídeo' });
  }
});

app.post('/api/admin/upload/presign', requireAdmin, async (req, res) => {
  try {
    const filename = String(req.body?.filename || 'file');
    const contentType = String(req.body?.contentType || 'application/octet-stream');
    const videoId = req.body?.videoId ? String(req.body.videoId) : null;

    const key = buildUploadKey(videoId, filename);
    const { cfg, client } = await signingClientAndBucket();

    if (!client || !cfg.signingReady) {
      return res.status(503).json({ error: 'Wasabi não configurado para upload' });
    }

    const command = new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
      ContentType: contentType,
    });
    const uploadUrl = await getSignedUrl(client, command, { expiresIn: 3600 });

    res.json({ uploadUrl, key, expiresIn: 3600 });
  } catch (e) {
    console.error('presign upload:', e);
    res.status(500).json({ error: 'Falha ao gerar URL de upload' });
  }
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`${SITE_NAME} — videos storefront on port ${PORT}`);
});
