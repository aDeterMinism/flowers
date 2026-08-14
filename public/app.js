const state = { config: null, active: 0, imageToken: 0, hoverTimer: 0, scrollFrame: 0, scrollTimer: 0, discoveryTimer: 0, previewCache: new Map() };
const $ = s => document.querySelector(s);
const dock = $('#flowerDock');
const dialog = $('#pickDialog');
const gardenShell = $('#gardenShell');
const mouseCapable = matchMedia('(hover: hover) and (pointer: fine)');
const mobileDock = matchMedia('(orientation: portrait), (max-width: 820px)');
const CONTACT_LIMITS = Object.freeze({ message: 2000, email: 254, qq: 12, wechat: 64, phone: 30, douyin: 80, redbook: 80, feishu: 100 });
const MAX_CLEAR_PAYLOAD_BYTES = 16 * 1024;

function setInputMode(pointerType) {
  document.documentElement.dataset.inputMode = pointerType === 'mouse' ? 'mouse' : 'touch';
}

setInputMode(mouseCapable.matches ? 'mouse' : 'touch');
document.addEventListener('pointerdown', event => setInputMode(event.pointerType), true);

function usesMouse() { return document.documentElement.dataset.inputMode === 'mouse'; }

function stopDiscovery() {
  clearTimeout(state.discoveryTimer);
  gardenShell.classList.remove('is-discovering');
}

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

function bytesToBase64(bytes) {
  let binary = ''; const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

function pemToBuffer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer;
}

async function sha256(text) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map(v => v.toString(16).padStart(2, '0')).join('');
}

async function canvasSignature() {
  const canvas = document.createElement('canvas'); canvas.width = 220; canvas.height = 40;
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'top'; ctx.font = '16px serif'; ctx.fillStyle = '#c58c62'; ctx.fillText('月光花园 ✿ Qixi', 4, 4);
  ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = '#326a65'; ctx.fillRect(74, 10, 88, 18);
  return sha256(canvas.toDataURL());
}

async function collectFingerprint() {
  const nav = navigator;
  return {
    collectedAt: new Date().toISOString(),
    userAgent: String(nav.userAgent || '').slice(0, 512), platform: String(nav.platform || '').slice(0, 80),
    languages: (nav.languages || []).slice(0, 20).map(value => String(value).slice(0, 35)),
    timezone: String(Intl.DateTimeFormat().resolvedOptions().timeZone || '').slice(0, 80),
    screen: { width: screen.width, height: screen.height, colorDepth: screen.colorDepth, pixelRatio: devicePixelRatio },
    hardware: { cores: nav.hardwareConcurrency || null, memory: nav.deviceMemory || null, touchPoints: nav.maxTouchPoints || 0 },
    canvasHash: await canvasSignature(), cookieEnabled: nav.cookieEnabled, doNotTrack: nav.doNotTrack
  };
}

async function encryptEnvelope(payload, publicKeyPem) {
  const publicKey = await crypto.subtle.importKey('spki', pemToBuffer(publicKeyPem), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  if (plaintext.byteLength > MAX_CLEAR_PAYLOAD_BYTES) throw new Error('提交内容总量过大，请缩短填写内容');
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plaintext);
  const rawKey = await crypto.subtle.exportKey('raw', aesKey);
  const wrappedKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, rawKey);
  return { version: 1, algorithm: 'RSA-OAEP-256+A256GCM', iv: bytesToBase64(iv), wrappedKey: bytesToBase64(new Uint8Array(wrappedKey)), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
}

function buildDock() {
  dock.querySelectorAll('[data-flower]').forEach(el => el.remove());
  const copies = mobileDock.matches ? 3 : 1;
  for (let copy = 0; copy < copies; copy += 1) state.config.flowers.forEach((flower, index) => {
    const button = document.createElement('button');
    button.className = `dock-item${flower.picked ? ' picked' : ''}`;
    button.dataset.flower = flower.id; button.dataset.index = index; button.dataset.cycle = copy;
    button.style.setProperty('--flower-color', flower.color);
    const symbol = document.createElement('span'); symbol.className = 'flower-symbol'; symbol.textContent = flower.icon;
    const label = document.createElement('em'); label.textContent = flower.species;
    button.append(symbol, label);
    button.setAttribute('aria-label', `${flower.species}：${flower.title}${flower.picked ? '，已被摘走' : ''}`);
    button.addEventListener('pointerenter', event => {
      stopDiscovery();
      if (!mobileDock.matches && event.pointerType === 'mouse' && usesMouse()) previewFlower(index, { deferFull: true });
    });
    button.addEventListener('focus', () => {
      stopDiscovery();
      if (!mobileDock.matches && usesMouse()) previewFlower(index, { deferFull: true });
    });
    button.addEventListener('click', event => {
      stopDiscovery();
      if (event.detail === 0 || usesMouse()) openPicker(index);
      else centerDockItem(button, 'smooth');
    });
    dock.appendChild(button);
  });
  setupDockMagnification();
  setupCircularDock();
  if (mobileDock.matches) requestAnimationFrame(() => centerDockIndex(state.active, 'auto'));
}

function setupDockMagnification() {
  if (dock.dataset.magnificationReady) return;
  dock.dataset.magnificationReady = 'true';
  dock.addEventListener('pointermove', event => {
    if (!usesMouse() || mobileDock.matches || event.pointerType !== 'mouse') return;
    dock.querySelectorAll('.dock-item').forEach(item => {
      const rect = item.getBoundingClientRect();
      const center = matchMedia('(orientation: portrait)').matches ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
      const pos = matchMedia('(orientation: portrait)').matches ? event.clientX : event.clientY;
      const distance = Math.abs(pos - center);
      item.style.setProperty('--scale', 1 + Math.max(0, 1 - distance / 105) * .34);
    });
  });
  dock.addEventListener('pointerleave', () => dock.querySelectorAll('.dock-item').forEach(item => item.style.setProperty('--scale', 1)));
}

function centerDockItem(item, behavior = 'smooth') {
  if (!mobileDock.matches || !item) return;
  dock.scrollTo({ left: item.offsetLeft - (dock.clientWidth - item.offsetWidth) / 2, behavior });
}

function centerDockIndex(index, behavior = 'auto') {
  centerDockItem(dock.querySelector(`[data-cycle="1"][data-index="${index}"]`), behavior);
}

function closestDockItem() {
  const center = dock.getBoundingClientRect().left + dock.clientWidth / 2;
  return [...dock.querySelectorAll('[data-flower]')].reduce((closest, item) => {
    const rect = item.getBoundingClientRect(); const distance = Math.abs(rect.left + rect.width / 2 - center);
    return !closest || distance < closest.distance ? { item, distance } : closest;
  }, null)?.item;
}

function settleCircularDock() {
  if (!mobileDock.matches) return;
  const item = closestDockItem(); if (!item) return;
  const index = Number(item.dataset.index);
  if (index !== state.active) previewFlower(index, { deferFull: true });
  if (item.dataset.cycle !== '1') centerDockIndex(index, 'auto');
}

function setupCircularDock() {
  if (dock.dataset.circularReady) return;
  dock.dataset.circularReady = 'true';
  dock.addEventListener('scroll', () => {
    if (!mobileDock.matches) return;
    cancelAnimationFrame(state.scrollFrame);
    state.scrollFrame = requestAnimationFrame(() => {
      const item = closestDockItem(); const index = Number(item?.dataset.index);
      if (Number.isInteger(index) && index !== state.active) previewFlower(index, { deferFull: true });
    });
    clearTimeout(state.scrollTimer); state.scrollTimer = setTimeout(settleCircularDock, 120);
  }, { passive: true });
}

function renderFlower(index) {
  state.active = index;
  const flower = state.config.flowers[index];
  const total = state.config.flowers.length;
  const remaining = state.config.flowers.filter(item => !item.picked).length;
  const positionWidth = Math.max(2, String(total).length);
  document.documentElement.style.setProperty('--accent', flower.color);
  $('#stageArt').style.setProperty('--focus', flower.mediaFocus);
  $('#stageIndex').textContent = String(index + 1).padStart(positionWidth, '0');
  $('#stageTotal').textContent = String(total).padStart(positionWidth, '0');
  $('#gardenCount').textContent = `共 ${total} 朵 · 剩余 ${remaining} 朵`;
  $('#stageSpecies').textContent = flower.species; $('#flowerNote').textContent = flower.note;
  $('#flowerTitle').textContent = flower.title; $('#flowerLine').textContent = flower.line;
  dock.querySelectorAll('[data-flower]').forEach(el => el.classList.toggle('selected', Number(el.dataset.index) === index));
  const availability = $('.availability'); availability.classList.toggle('is-picked', flower.picked);
  $('#availabilityText').textContent = flower.picked ? '当前已有归处' : '当前可摘';
  const button = $('#pickButton'); button.disabled = flower.picked || !state.config.publicKey;
  button.querySelector('span').textContent = flower.picked ? '这朵花已有归处' : state.config.publicKey ? '摘下这朵花' : '花园尚未开放摘取';
  const story = state.config.pickedStories.find(s => s.flowerId === flower.id);
  $('#pickedNote').hidden = !story; if (story) $('#pickedNote p').textContent = story.message;
}

function showAdjacentFlower(direction) {
  const total = state.config?.flowers.length || 0;
  if (total < 2) return;
  stopDiscovery();
  const nextIndex = (state.active + direction + total) % total;
  previewFlower(nextIndex);
  if (mobileDock.matches) centerDockIndex(nextIndex, 'smooth');
}

function showCachedPreview(flower) {
  const cached = state.previewCache.get(flower.preview);
  if (cached?.complete && cached.naturalWidth) $('#stagePreview').src = flower.preview;
}

async function loadFullImage(flower, token) {
  const image = new Image(); image.decoding = 'async'; image.src = flower.image;
  try { await image.decode(); } catch { await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; }); }
  if (token !== state.imageToken) return;
  const stageImage = $('#stageImage'); stageImage.src = flower.image;
  requestAnimationFrame(() => stageImage.classList.remove('is-loading'));
}

function previewFlower(index, { deferFull = false } = {}) {
  clearTimeout(state.hoverTimer);
  renderFlower(index);
  const flower = state.config.flowers[index]; const token = ++state.imageToken;
  const stageImage = $('#stageImage');
  if (stageImage.getAttribute('src') === flower.image && stageImage.complete && stageImage.naturalWidth) { stageImage.classList.remove('is-loading'); return; }
  const cachedPreview = state.previewCache.get(flower.preview);
  if (cachedPreview?.complete && cachedPreview.naturalWidth) { showCachedPreview(flower); $('#stageImage').classList.add('is-loading'); }
  const begin = () => loadFullImage(flower, token).catch(() => { if (token === state.imageToken) $('#stageImage').classList.remove('is-loading'); });
  if (deferFull) state.hoverTimer = setTimeout(begin, 130); else begin();
}

function preloadSmallPreviews() {
  if (navigator.connection?.saveData || /(^|-)2g$/.test(navigator.connection?.effectiveType || '')) return;
  const start = () => state.config.flowers.forEach(flower => {
    if (!flower.preview || state.previewCache.has(flower.preview)) return;
    const image = new Image(); image.decoding = 'async'; image.src = flower.preview;
    image.onload = () => { state.previewCache.set(flower.preview, image); if (state.config.flowers[state.active]?.preview === flower.preview) showCachedPreview(flower); };
    state.previewCache.set(flower.preview, image);
  });
  if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 1200 }); else setTimeout(start, 300);
}

function openPicker(index = state.active) {
  clearTimeout(state.hoverTimer);
  previewFlower(index);
  const flower = state.config.flowers[index];
  if (flower.picked) { showToast('这朵花已经有归处了'); return; }
  if (!state.config.publicKey) { showToast('花园尚未开放摘取'); return; }
  $('#modalFlower').textContent = flower.species;
  $('#shareMessageWrap').hidden = !state.config.allowPlainMessage; $('#shareEmailWrap').hidden = !state.config.allowPlainEmail;
  syncPlainOptions();
  $('#formStatus').textContent = ''; dialog.showModal();
}

function syncPlainOption(inputId, checkboxId, wrapperId, allowed) {
  const hasContent = $(`#${inputId}`).value.trim().length > 0;
  const checkbox = $(`#${checkboxId}`);
  const wrapper = $(`#${wrapperId}`);
  const enabled = Boolean(allowed && hasContent);
  checkbox.disabled = !enabled;
  if (!enabled) checkbox.checked = false;
  wrapper.classList.toggle('is-disabled', !enabled);
  wrapper.setAttribute('aria-disabled', String(!enabled));
}

function syncPlainOptions() {
  syncPlainOption('message', 'shareMessage', 'shareMessageWrap', state.config?.allowPlainMessage);
  syncPlainOption('email', 'shareEmail', 'shareEmailWrap', state.config?.allowPlainEmail);
}

async function submitPick(event) {
  event.preventDefault();
  if (!$('#pickForm').checkValidity()) { $('#pickForm').reportValidity(); return; }
  const includeDiagnostics = $('#consent').checked;
  const button = $('#submitPick'); button.disabled = true;
  $('#formStatus').textContent = includeDiagnostics ? '正在本地收集并加密…' : '正在本地加密…';
  const flower = state.config.flowers[state.active];
  try {
    const contact = Object.fromEntries(Object.entries(CONTACT_LIMITS).map(([field, limit]) => {
      const value = $(`#${field}`).value.trim();
      if (value.length > limit) throw new Error(`${$(`#${field}`).closest('label').childNodes[0].textContent.trim()}不能超过 ${limit} 个字符`);
      return [field, value];
    }));
    const payload = {
      flower: { id: flower.id, species: flower.species, title: flower.title },
      fingerprint: includeDiagnostics ? await collectFingerprint() : null,
      contact
    };
    const envelope = await encryptEnvelope(payload, state.config.publicKey);
    await api('/api/pick', { method: 'POST', body: JSON.stringify({ flowerId: flower.id, envelope, plainMessage: contact.message, plainEmail: contact.email, shareMessage: $('#shareMessage').checked, shareEmail: $('#shareEmail').checked }) });
    dialog.close(); showToast(`「${flower.species}」已经属于你了`);
    await load();
  } catch (error) { $('#formStatus').textContent = error.message; }
  finally { button.disabled = false; }
}

function showToast(message) { const t = $('#toast'); t.textContent = message; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 3400); }

async function load() {
  try {
    state.config = await api('/api/config');
    document.title = state.config.gardenName; $('#gardenName').textContent = state.config.gardenName; $('#invitation').textContent = state.config.invitation;
    gardenShell.classList.toggle('single-flower', state.config.flowers.length < 2);
    buildDock(); previewFlower(Math.min(state.active, state.config.flowers.length - 1)); preloadSmallPreviews();
  } catch (error) { showToast(error.message); }
}

$('#pickButton').addEventListener('click', () => openPicker());
$('#prevFlower').addEventListener('click', () => showAdjacentFlower(-1));
$('#nextFlower').addEventListener('click', () => showAdjacentFlower(1));
$('#pickForm').addEventListener('submit', submitPick);
$('#message').addEventListener('input', syncPlainOptions);
$('#email').addEventListener('input', syncPlainOptions);
$('.modal-close').addEventListener('click', () => dialog.close());
dock.addEventListener('pointerdown', stopDiscovery, { passive: true });
dock.addEventListener('wheel', stopDiscovery, { passive: true });
mobileDock.addEventListener('change', () => { if (state.config) buildDock(); });
document.addEventListener('keydown', event => {
  if (dialog.open || event.target.closest('input, textarea, button, a')) return;
  if (event.key === 'ArrowLeft') { event.preventDefault(); showAdjacentFlower(-1); }
  if (event.key === 'ArrowRight') { event.preventDefault(); showAdjacentFlower(1); }
});
state.discoveryTimer = setTimeout(stopDiscovery, 2600);
load();
