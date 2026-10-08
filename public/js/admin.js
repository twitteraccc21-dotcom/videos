const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  user: null,
  videos: [],
  editingId: null,
  pendingVideoFile: null,
  pendingVideoPreviewUrl: null,
  cryptoWallets: [],
  purchases: [],
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

function show(el) {
  el.hidden = false;
}
function hide(el) {
  el.hidden = true;
}

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' toast-error' : '');
  show(t);
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => hide(t), 4000);
}

function formatPrice(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

function formatBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

const UPLOAD_UI = {
  video: {
    block: () => $('#upload-video-block'),
    status: () => $('#upload-video-status'),
    progress: () => $('#upload-video-progress'),
    fill: () => $('#upload-video-fill'),
    pct: () => $('#upload-video-pct'),
  },
};

function resetUploadProgress(kind) {
  const ui = UPLOAD_UI[kind];
  if (!ui) return;
  ui.block()?.classList.remove('is-uploading');
  hide(ui.progress());
  const fill = ui.fill();
  if (fill) {
    fill.style.width = '0%';
    fill.classList.remove('done');
  }
  if (ui.pct()) ui.pct().textContent = '0%';
}

function setUploadProgress(kind, pct, label, done = false) {
  const ui = UPLOAD_UI[kind];
  if (!ui) return;
  const clamped = Math.max(0, Math.min(100, pct));
  ui.block()?.classList.add('is-uploading');
  show(ui.progress());
  const fill = ui.fill();
  if (fill) {
    fill.style.width = `${clamped}%`;
    fill.classList.toggle('done', done);
  }
  if (ui.pct()) ui.pct().textContent = `${Math.round(clamped)}%`;
  if (label && ui.status()) ui.status().textContent = label;
}

function setSaveOverlay(showOverlay, pct = 0, msg = '') {
  const overlay = $('#save-overlay');
  const fill = $('#save-overlay-fill');
  const pctEl = $('#save-overlay-pct');
  const msgEl = $('#save-overlay-msg');
  if (!overlay) return;
  if (showOverlay) {
    show(overlay);
    if (msgEl && msg) msgEl.textContent = msg;
    if (fill) fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    if (pctEl) pctEl.textContent = `${Math.round(pct)}%`;
  } else {
    hide(overlay);
    if (fill) fill.style.width = '0%';
    if (pctEl) pctEl.textContent = '0%';
  }
}

function posterAtFromForm() {
  const n = Number($('#field-poster_at')?.value);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

function revokePendingPreview() {
  if (state.pendingVideoPreviewUrl) {
    URL.revokeObjectURL(state.pendingVideoPreviewUrl);
    state.pendingVideoPreviewUrl = null;
  }
}

async function updateVideoPreview(url, atSec) {
  const wrap = $('#video-preview-wrap');
  const inner = $('#video-preview-inner');
  if (!wrap || !inner) return;
  if (!url) {
    hide(wrap);
    inner.innerHTML = '';
    return;
  }
  show(wrap);
  inner.innerHTML = '<video class="video-preview" muted playsinline preload="metadata" aria-hidden="true"></video>';
  const container = inner;
  try {
    if (typeof Storefront !== 'undefined') {
      await Storefront.applyVideoPoster(container, url, atSec);
    }
  } catch {
    hide(wrap);
  }
}

async function checkAuth() {
  try {
    const { user } = await api('/api/admin/me');
    state.user = user;
    return true;
  } catch {
    state.user = null;
    return false;
  }
}

function showLogin() {
  hide($('#dashboard'));
  show($('#login-screen'));
}

function showDashboard() {
  hide($('#login-screen'));
  show($('#dashboard'));
  $('#admin-email').textContent = state.user?.email || '';
  loadSettings();
  loadPurchases();
}

async function loadSettings() {
  const hint = $('#telegram-hint');
  const input = $('#field-telegram');
  const cryptoHint = $('#crypto-hint');
  try {
    const s = await api('/api/admin/settings');
    input.value = s.telegram_username || '';
    const effective = s.telegram_effective || s.telegram_from_env || '';
    let hintHtml = effective
      ? `Ativo na loja: <a href="https://t.me/${encodeURIComponent(effective)}" target="_blank" rel="noopener">@${escapeHtml(effective)}</a>`
      : 'Nenhum username configurado — botões Support ficam desativados.';
    if (s.telegram_from_env && s.telegram_from_env !== s.telegram_username) {
      hintHtml += ` · Fallback env: @${escapeHtml(s.telegram_from_env)}`;
    }
    hint.innerHTML = hintHtml;

    state.cryptoWallets = Array.isArray(s.crypto_wallets) ? s.crypto_wallets.map((w) => ({ ...w })) : [];
    renderCryptoList();
    const effectiveCrypto = s.crypto_effective || [];
    if (effectiveCrypto.length) {
      cryptoHint.textContent = `${effectiveCrypto.length} carteira(s) ativa(s) na loja`;
    } else if (Array.isArray(s.crypto_from_env) && s.crypto_from_env.length) {
      cryptoHint.textContent = `Nenhuma na BD — a usar ${s.crypto_from_env.length} da env`;
    } else {
      cryptoHint.textContent = 'Nenhuma carteira configurada';
    }

    if ($('#account-email')) {
      $('#account-email').value = state.user?.email || '';
    }
  } catch (err) {
    hint.textContent = err.message;
    hint.classList.add('error-text');
  }
}

function renderCryptoList() {
  const list = $('#crypto-list');
  if (!list) return;
  if (!state.cryptoWallets.length) {
    list.innerHTML = '<p class="crypto-empty">Nenhuma carteira. Clique em "+ Adicionar carteira".</p>';
    return;
  }
  list.innerHTML = state.cryptoWallets
    .map(
      (w, i) => `<div class="crypto-edit-row" data-idx="${i}">
        <input type="text" class="crypto-symbol" placeholder="BTC" value="${escapeHtml(w.symbol || '')}" maxlength="16">
        <input type="text" class="crypto-label" placeholder="Label (opcional)" value="${escapeHtml(w.label || '')}" maxlength="40">
        <input type="text" class="crypto-address" placeholder="Endereço da carteira" value="${escapeHtml(w.address || '')}">
        <button type="button" class="btn btn-sm btn-danger crypto-remove" data-idx="${i}">✕</button>
      </div>`
    )
    .join('');

  list.querySelectorAll('.crypto-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      collectCryptoFromDom();
      state.cryptoWallets.splice(Number(btn.dataset.idx), 1);
      renderCryptoList();
    });
  });
}

function collectCryptoFromDom() {
  const rows = $$('.crypto-edit-row', $('#crypto-list'));
  state.cryptoWallets = rows
    .map((row) => ({
      symbol: row.querySelector('.crypto-symbol')?.value.trim() || 'CRYPTO',
      label: row.querySelector('.crypto-label')?.value.trim() || '',
      address: row.querySelector('.crypto-address')?.value.trim() || '',
    }))
    .filter((w) => w.address);
}

function addCryptoRow() {
  collectCryptoFromDom();
  state.cryptoWallets.push({ symbol: '', label: '', address: '' });
  renderCryptoList();
  const rows = $$('.crypto-edit-row', $('#crypto-list'));
  const last = rows[rows.length - 1];
  last?.querySelector('.crypto-symbol')?.focus();
}

async function saveCrypto() {
  const btn = $('#save-crypto-btn');
  btn.disabled = true;
  try {
    collectCryptoFromDom();
    await api('/api/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify({ crypto_wallets: state.cryptoWallets }),
    });
    toast('Carteiras crypto guardadas');
    await loadSettings();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function saveAccount() {
  const btn = $('#save-account-btn');
  btn.disabled = true;
  try {
    const payload = {
      current_password: $('#account-current-password').value,
      email: $('#account-email').value.trim(),
    };
    const newPass = $('#account-new-password').value;
    if (newPass) payload.new_password = newPass;

    const { user } = await api('/api/admin/account', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    state.user = user;
    $('#admin-email').textContent = user.email || '';
    $('#account-current-password').value = '';
    $('#account-new-password').value = '';
    toast('Conta atualizada');
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function saveTelegram() {
  const btn = $('#save-telegram-btn');
  btn.disabled = true;
  try {
    const raw = $('#field-telegram').value.trim();
    await api('/api/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify({ telegram_username: raw }),
    });
    toast('Telegram atualizado');
    await loadSettings();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const btn = $('#login-btn');
  btn.disabled = true;
  try {
    const email = $('#login-email').value.trim();
    const password = $('#login-password').value;
    const { user } = await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    state.user = user;
    showDashboard();
    await Promise.all([loadVideos(), loadPurchases()]);
    toast('Login efetuado');
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function handleLogout() {
  try {
    await api('/api/admin/logout', { method: 'POST' });
  } catch {
    /* ignore */
  }
  state.user = null;
  showLogin();
}

function pickPurchaseField(row, keys, fallback = '') {
  for (const key of keys) {
    if (row[key] != null && String(row[key]).trim() !== '') return row[key];
  }
  return fallback;
}

function formatPurchaseDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('pt-PT', { dateStyle: 'short', timeStyle: 'short' });
}

function formatPurchaseAmount(row) {
  const amount = Number(pickPurchaseField(row, ['amount', 'price', 'total'], ''));
  const currency = String(pickPurchaseField(row, ['currency'], 'USD') || 'USD').toUpperCase();
  if (!Number.isFinite(amount)) return '—';
  return `${currency === 'USD' ? '$' : currency + ' '}${amount.toFixed(2)}`;
}

function purchaseVideoTitle(row) {
  const joined = row.videos;
  if (joined && typeof joined === 'object' && !Array.isArray(joined) && joined.title) return joined.title;
  if (Array.isArray(joined) && joined[0]?.title) return joined[0].title;
  return pickPurchaseField(row, ['product_title', 'title', 'video_title'], row.video_id ? String(row.video_id).slice(0, 8) : 'Pacote / todos');
}

function purchaseProvider(row) {
  const raw = String(pickPurchaseField(row, ['payment_method', 'provider', 'source', 'method'], '')).toLowerCase();
  if (raw.includes('paypal')) return 'PayPal';
  if (raw.includes('payjsr')) return 'PayJSR';
  if (raw.includes('whop') || raw === 'who') return 'Whop';
  if (raw) return raw;
  return '—';
}

async function loadPurchases() {
  const tbody = $('#purchases-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" class="muted center">A carregar…</td></tr>';
  try {
    const { purchases } = await api('/api/admin/purchases');
    state.purchases = Array.isArray(purchases) ? purchases : [];
    renderPurchaseTable();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="center error-text">${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderPurchaseTable() {
  const tbody = $('#purchases-tbody');
  if (!tbody) return;
  if (!state.purchases.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="muted center">Ainda não há pagamentos gravados.</td></tr>';
    return;
  }

  tbody.innerHTML = state.purchases.map((row) => {
    const name = pickPurchaseField(row, ['buyer_name', 'name', 'customer_name'], '—');
    const email = pickPurchaseField(row, ['buyer_email', 'email', 'customer_email'], '—');
    const ref = pickPurchaseField(row, ['transaction_id', 'provider_ref', 'paypal_order_id', 'reference', 'order_id', 'id'], '—');
    const when = formatPurchaseDate(pickPurchaseField(row, ['created_at', 'paid_at', 'inserted_at'], ''));
    return `<tr>
      <td>${escapeHtml(when)}</td>
      <td>${escapeHtml(name)}</td>
      <td class="email-cell">${escapeHtml(email)}</td>
      <td>${escapeHtml(purchaseVideoTitle(row))}</td>
      <td>${escapeHtml(formatPurchaseAmount(row))}</td>
      <td>${escapeHtml(purchaseProvider(row))}</td>
      <td class="muted email-cell">${escapeHtml(String(ref))}</td>
    </tr>`;
  }).join('');
}

async function loadVideos() {
  const tbody = $('#videos-tbody');
  tbody.innerHTML = '<tr><td colspan="7" class="muted center">A carregar…</td></tr>';
  try {
    const { videos } = await api('/api/admin/videos');
    state.videos = videos;
    renderVideoTable();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="center error-text">${err.message}</td></tr>`;
  }
}

function renderVideoTable() {
  const tbody = $('#videos-tbody');
  if (!state.videos.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="muted center">Nenhum vídeo. Clique em "Novo vídeo".</td></tr>';
    return;
  }

  tbody.innerHTML = state.videos
    .map((v) => {
      const status = v.is_active
        ? '<span class="badge badge-ok">Ativo</span>'
        : '<span class="badge badge-off">Inativo</span>';
      const price = v.is_free ? 'Grátis' : `$${formatPrice(v.price)}`;
      const dur = v.duration ? `<span class="muted" style="font-size:0.75rem;display:block">${escapeHtml(v.duration)}</span>` : '';
      return `<tr data-id="${v.id}">
        <td class="thumb-cell"><div class="thumb-placeholder">…</div><div class="thumb-vid-wrap" hidden></div></td>
        <td><strong>${escapeHtml(v.title)}</strong>${dur}</td>
        <td>${price}</td>
        <td>${v.views ?? 0}</td>
        <td>${v.sort_order ?? 0}</td>
        <td>${status}</td>
        <td class="actions-cell">
          <button type="button" class="btn-sm btn-edit" data-action="edit">Editar</button>
          <a href="/watch?id=${encodeURIComponent(v.id)}" target="_blank" class="btn-sm btn-ghost">Ver</a>
          ${v.is_active ? `<button type="button" class="btn-sm btn-danger" data-action="delete">Desativar</button>` : ''}
        </td>
      </tr>`;
    })
    .join('');

  tbody.querySelectorAll('[data-action="edit"]').forEach((btn) => {
    btn.addEventListener('click', () => openEditor(btn.closest('tr').dataset.id));
  });
  tbody.querySelectorAll('[data-action="delete"]').forEach((btn) => {
    btn.addEventListener('click', () => deactivateVideo(btn.closest('tr').dataset.id));
  });

  loadTableThumbs();
}

async function loadTableThumbs() {
  if (typeof Storefront === 'undefined') return;

  for (const row of $$('#videos-tbody tr[data-id]')) {
    const v = state.videos.find((x) => x.id === row.dataset.id);
    if (!v) continue;

    const ph = row.querySelector('.thumb-placeholder');
    const wrap = row.querySelector('.thumb-vid-wrap');
    if (!wrap) continue;

    const ok = await Storefront.hydrateVideoPoster(v, wrap, {
      onReady: () => {
        wrap.hidden = false;
        wrap.querySelector('video')?.classList.add('thumb-vid');
        if (ph) ph.hidden = true;
      },
      onError: () => {
        if (ph) ph.textContent = '—';
      },
    });

    if (!ok && ph) ph.textContent = '—';
  }
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function resetForm() {
  state.editingId = null;
  state.pendingVideoFile = null;
  revokePendingPreview();
  $('#video-form').reset();
  $('#field-id').value = '';
  $('#field-is_active').checked = true;
  $('#field-is_free').checked = false;
  $('#field-poster_at').value = '1';
  $('#upload-video-status').textContent = '';
  resetUploadProgress('video');
  $('#field-video_file_id').value = '';
  updateVideoPreview(null);
  $('#editor-title').textContent = 'Novo vídeo';
}

function openEditor(id) {
  const v = state.videos.find((x) => x.id === id);
  if (!v) return;

  state.editingId = id;
  state.pendingVideoFile = null;
  revokePendingPreview();
  $('#editor-title').textContent = 'Editar vídeo';
  $('#field-id').value = v.id;
  $('#field-title').value = v.title || '';
  $('#field-description').value = v.description || '';
  $('#field-price').value = v.price ?? 0;
  $('#field-duration').value = v.duration || '';
  $('#field-sort_order').value = v.sort_order ?? 0;
  $('#field-poster_at').value = v.poster_at ?? 1;
  $('#field-product_link').value = v.product_link || '';
  $('#field-video_file_id').value = v.video_file_id || '';
  $('#field-is_active').checked = v.is_active !== false;
  $('#field-is_free').checked = v.is_free === true;
  $('#upload-video-status').textContent = v.video_file_id ? `Atual: ${v.video_file_id}` : '';
  show($('#editor-panel'));

  if (typeof Storefront !== 'undefined' && (v.wasabi_video_key || v.public_video_url)) {
    Storefront.resolvePlaybackUrl(v).then((url) => {
      if (url) updateVideoPreview(url, v.poster_at ?? 1);
    });
  } else {
    updateVideoPreview(null);
  }
}

function closeEditor() {
  hide($('#editor-panel'));
  resetForm();
}

async function uploadFile(file, videoId, onProgress) {
  const { uploadUrl, key } = await api('/api/admin/upload/presign', {
    method: 'POST',
    body: JSON.stringify({
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      videoId,
    }),
  });

  onProgress?.(0, 'A ligar ao Wasabi…');

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

    xhr.upload.addEventListener('progress', (e) => {
      if (!e.lengthComputable) return;
      const pct = (e.loaded / e.total) * 100;
      onProgress?.(
        pct,
        `A enviar… ${formatBytes(e.loaded)} / ${formatBytes(e.total)}`
      );
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100, 'Upload concluído', true);
        resolve(key);
      } else {
        reject(new Error(`Upload falhou (${xhr.status})`));
      }
    });
    xhr.addEventListener('error', () => reject(new Error('Erro de rede no upload')));
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelado')));

    xhr.send(file);
  });
}

async function handleFilePick(input) {
  const file = input.files?.[0];
  if (!file) return;
  state.pendingVideoFile = file;
  revokePendingPreview();
  state.pendingVideoPreviewUrl = URL.createObjectURL(file);
  $('#upload-video-status').textContent = `Selecionado: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`;
  await updateVideoPreview(state.pendingVideoPreviewUrl, posterAtFromForm());
}

async function handleSave(e) {
  e.preventDefault();
  const btn = $('#save-btn');
  const closeBtn = $('#close-editor');
  btn.disabled = true;
  if (closeBtn) closeBtn.disabled = true;

  const hasVideo = !!state.pendingVideoFile;
  const steps = 1 + (hasVideo ? 1 : 0);

  function overallPct(stepIndex, filePct = 0) {
    const base = (stepIndex / steps) * 100;
    const slice = 100 / steps;
    return base + (filePct / 100) * slice;
  }

  try {
    const payload = {
      title: $('#field-title').value.trim(),
      description: $('#field-description').value.trim(),
      price: Number($('#field-price').value) || 0,
      duration: $('#field-duration').value.trim(),
      sort_order: Number($('#field-sort_order').value) || 0,
      poster_at: posterAtFromForm(),
      product_link: $('#field-product_link').value.trim() || null,
      is_active: $('#field-is_active').checked,
      is_free: $('#field-is_free').checked,
      video_file_id: $('#field-video_file_id').value.trim() || null,
    };

    if (!payload.title) {
      toast('Título é obrigatório', true);
      return;
    }

    setSaveOverlay(true, 2, 'A guardar metadados…');

    let videoId = state.editingId;
    let step = 0;

    if (videoId) {
      await api(`/api/admin/videos/${videoId}`, { method: 'PATCH', body: JSON.stringify(payload) });
    } else {
      const { video } = await api('/api/admin/videos', { method: 'POST', body: JSON.stringify(payload) });
      videoId = video.id;
      state.editingId = videoId;
      $('#field-id').value = videoId;
    }

    step += 1;
    setSaveOverlay(true, overallPct(step), hasVideo ? 'Metadados guardados — a enviar vídeo…' : 'A concluir…');

    if (state.pendingVideoFile) {
      const file = state.pendingVideoFile;
      setUploadProgress('video', 0, `A preparar: ${file.name} (${formatBytes(file.size)})`);
      const key = await uploadFile(file, videoId, (pct, label, done) => {
        setUploadProgress('video', pct, label, done);
        setSaveOverlay(true, overallPct(step, pct), label || 'A enviar vídeo…');
      });
      await api(`/api/admin/videos/${videoId}`, {
        method: 'PATCH',
        body: JSON.stringify({ video_file_id: key }),
      });
      $('#field-video_file_id').value = key;
      state.pendingVideoFile = null;
      setUploadProgress('video', 100, `Enviado: ${file.name}`, true);
      step += 1;
    }

    setSaveOverlay(true, 100, 'Concluído!');
    toast('Vídeo guardado');
    await loadVideos();
    setTimeout(() => closeEditor(), 400);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    if (closeBtn) closeBtn.disabled = false;
    setSaveOverlay(false);
  }
}

async function deactivateVideo(id) {
  const v = state.videos.find((x) => x.id === id);
  if (!v || !confirm(`Desativar "${v.title}"? Deixa de aparecer na loja.`)) return;
  try {
    await api(`/api/admin/videos/${id}`, { method: 'DELETE' });
    toast('Vídeo desativado');
    await loadVideos();
  } catch (err) {
    toast(err.message, true);
  }
}

function init() {
  $('#login-form').addEventListener('submit', handleLogin);
  $('#logout-btn').addEventListener('click', handleLogout);
  $('#new-video-btn').addEventListener('click', () => {
    resetForm();
    show($('#editor-panel'));
  });
  $('#close-editor').addEventListener('click', closeEditor);
  $('#video-form').addEventListener('submit', handleSave);
  $('#refresh-btn').addEventListener('click', () => {
    loadVideos();
    loadPurchases();
  });
  $('#save-telegram-btn').addEventListener('click', saveTelegram);
  $('#add-crypto-btn').addEventListener('click', addCryptoRow);
  $('#save-crypto-btn').addEventListener('click', saveCrypto);
  $('#save-account-btn').addEventListener('click', saveAccount);
  $('#pick-video').addEventListener('change', (e) => handleFilePick(e.target));
  $('#field-poster_at')?.addEventListener('change', async () => {
    const at = posterAtFromForm();
    if (state.pendingVideoPreviewUrl) {
      await updateVideoPreview(state.pendingVideoPreviewUrl, at);
      return;
    }
    const v = state.videos.find((x) => x.id === state.editingId);
    if (v && typeof Storefront !== 'undefined') {
      const url = await Storefront.resolvePlaybackUrl(v);
      if (url) updateVideoPreview(url, at);
    }
  });

  checkAuth().then((ok) => {
    if (ok) {
      showDashboard();
      loadVideos();
      loadPurchases();
    } else {
      showLogin();
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
