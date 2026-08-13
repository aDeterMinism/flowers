const state = { config: null, selected: 0 };
const $ = s => document.querySelector(s);
const dock = $('#flowerDock');
const dialog = $('#pickDialog');
const CONTACT_LIMITS = Object.freeze({ message: 2000, email: 254, qq: 12, wechat: 64, phone: 30, douyin: 80, redbook: 80, feishu: 100 });
const MAX_CLEAR_PAYLOAD_BYTES = 16 * 1024;

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
  state.config.flowers.forEach((flower, index) => {
    const button = document.createElement('button');
    button.className = `dock-item${flower.picked ? ' picked' : ''}`;
    button.dataset.flower = flower.id; button.style.setProperty('--flower-color', flower.color);
    const symbol = document.createElement('span'); symbol.className = 'flower-symbol'; symbol.textContent = flower.icon;
    const label = document.createElement('em'); label.textContent = flower.species;
    button.append(symbol, label);
    button.setAttribute('aria-label', `${flower.species}：${flower.title}${flower.picked ? '，已被摘走' : ''}`);
    button.addEventListener('click', () => selectFlower(index));
    dock.appendChild(button);
  });
  setupDockMagnification();
}

function setupDockMagnification() {
  if (matchMedia('(pointer: coarse)').matches) return;
  dock.addEventListener('pointermove', event => {
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

function selectFlower(index) {
  state.selected = index;
  const flower = state.config.flowers[index];
  document.documentElement.style.setProperty('--accent', flower.color);
  $('#stageArt').style.setProperty('--focus', flower.mediaFocus);
  $('#stageIndex').textContent = String(index + 1).padStart(2, '0');
  $('#stageSpecies').textContent = flower.species; $('#flowerNote').textContent = flower.note;
  $('#flowerTitle').textContent = flower.title; $('#flowerLine').textContent = flower.line;
  dock.querySelectorAll('[data-flower]').forEach((el, i) => el.classList.toggle('selected', i === index));
  const availability = $('.availability'); availability.classList.toggle('is-picked', flower.picked);
  $('#availabilityText').textContent = flower.picked ? '已经被人轻轻带走了' : '还在花园里';
  const button = $('#pickButton'); button.disabled = flower.picked || !state.config.publicKey;
  button.querySelector('span').textContent = flower.picked ? '这朵花已有归处' : state.config.publicKey ? '摘下这朵花' : '花园尚未开放摘取';
  const story = state.config.pickedStories.find(s => s.flowerId === flower.id);
  $('#pickedNote').hidden = !story; if (story) $('#pickedNote p').textContent = story.message;
  dock.querySelector(`[data-flower="${flower.id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
}

function openPicker() {
  const flower = state.config.flowers[state.selected]; if (flower.picked) return;
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
  if (!$('#consent').checked) { $('#formStatus').textContent = '请先确认指纹采集授权'; return; }
  if (!$('#pickForm').checkValidity()) { $('#pickForm').reportValidity(); return; }
  const button = $('#submitPick'); button.disabled = true; $('#formStatus').textContent = '正在本地收集并加密…';
  const flower = state.config.flowers[state.selected];
  try {
    const contact = Object.fromEntries(Object.entries(CONTACT_LIMITS).map(([field, limit]) => {
      const value = $(`#${field}`).value.trim();
      if (value.length > limit) throw new Error(`${$(`#${field}`).closest('label').childNodes[0].textContent.trim()}不能超过 ${limit} 个字符`);
      return [field, value];
    }));
    const payload = {
      flower: { id: flower.id, species: flower.species, title: flower.title },
      fingerprint: await collectFingerprint(),
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
    buildDock(); selectFlower(Math.min(state.selected, state.config.flowers.length - 1));
  } catch (error) { showToast(error.message); }
}

$('#pickButton').addEventListener('click', openPicker);
$('#pickForm').addEventListener('submit', submitPick);
$('#message').addEventListener('input', syncPlainOptions);
$('#email').addEventListener('input', syncPlainOptions);
$('.modal-close').addEventListener('click', () => dialog.close());
load();
