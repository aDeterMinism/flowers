const state = { db: null, privateKey: null };
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || '请求失败'), { status: response.status });
  return data;
}

function base64ToBytes(value) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
function bufferToPem(buffer, label) { const b64 = btoa(String.fromCharCode(...new Uint8Array(buffer))).match(/.{1,64}/g).join('\n'); return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----`; }
function download(name, data, type = 'application/json') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }

async function loadState() {
  try { state.db = await api('/api/admin/state'); $('#loginView').hidden = true; $('#adminApp').hidden = false; render(); }
  catch (error) { if (error.status !== 401) $('#loginError').textContent = error.message; }
}

function render() {
  const { config, claims } = state.db;
  $('#totalCount').textContent = config.flowers.length; $('#pickedCount').textContent = claims.length; $('#remainCount').textContent = Math.max(0, config.flowers.length - claims.length);
  $('#gardenNameInput').value = config.gardenName; $('#invitationInput').value = config.invitation;
  $('#publicKeyInput').value = config.publicKey; $('#allowPlainMessage').checked = config.allowPlainMessage; $('#allowPlainEmail').checked = config.allowPlainEmail;
  $('#smtpHost').value = config.smtp.host; $('#smtpPort').value = config.smtp.port; $('#smtpSecure').checked = true; $('#smtpUsername').value = config.smtp.username; $('#smtpPassword').value = config.smtp.password; $('#smtpFrom').value = config.smtp.from; $('#mailSubject').value = config.autoReply.subject; $('#mailTemplate').value = config.autoReply.template;
  renderFlowers(); renderRecords();
}

function renderFlowers() {
  const root = $('#flowerEditor'); root.innerHTML = '';
  state.db.config.flowers.forEach((flower, index) => {
    const row = document.createElement('div'); row.className = 'flower-row';
    row.innerHTML = `<div class="mini-stack"><input type="color" data-k="color" value="${escapeHtml(flower.color)}"><input data-k="icon" value="${escapeHtml(flower.icon)}" title="符号"></div><input data-k="species" value="${escapeHtml(flower.species)}" placeholder="品种"><input data-k="title" value="${escapeHtml(flower.title)}" placeholder="标题"><textarea data-k="line" placeholder="一句话">${escapeHtml(flower.line)}</textarea><button title="删除">×</button>`;
    row.querySelectorAll('[data-k]').forEach(input => input.addEventListener('input', () => { flower[input.dataset.k] = input.value; }));
    row.querySelector('button').addEventListener('click', () => { if (confirm(`删除「${flower.title || flower.species}」？已摘取记录不会一并删除。`)) { state.db.config.flowers.splice(index, 1); renderFlowers(); } });
    root.appendChild(row);
  });
}

function renderRecords() {
  const root = $('#recordsList'); root.innerHTML = '';
  if (!state.db.claims.length) { root.innerHTML = '<p class="explain">还没有人来摘花。花园很安静。</p>'; return; }
  state.db.claims.slice().reverse().forEach(claim => {
    const item = document.createElement('article'); item.className = 'record';
    item.innerHTML = `<div><h3>${escapeHtml(claim.flowerSpecies)}</h3><p>${escapeHtml(new Date(claim.createdAt).toLocaleString())}</p></div><p class="record-message">${escapeHtml(claim.plainMessage || '没有公开留言')} · 邮件 ${escapeHtml(claim.mail?.status || 'unknown')}</p><div><button class="decrypt">${state.privateKey ? '本地解密' : '查看密文'}</button><button class="delete">删除</button></div>`;
    item.querySelector('.decrypt').addEventListener('click', () => inspectRecord(claim));
    item.querySelector('.delete').addEventListener('click', async () => { if (!confirm('删除这条记录并让花重新可摘？此操作无法恢复。')) return; await api(`/api/admin/claims/${claim.id}`, { method: 'DELETE' }); await loadState(); });
    root.appendChild(item);
  });
}

function collectConfig() {
  const c = state.db.config;
  c.gardenName = $('#gardenNameInput').value; c.invitation = $('#invitationInput').value; c.publicKey = $('#publicKeyInput').value;
  c.allowPlainMessage = $('#allowPlainMessage').checked; c.allowPlainEmail = $('#allowPlainEmail').checked;
  c.smtp = { host: $('#smtpHost').value, port: Number($('#smtpPort').value), secure: true, username: $('#smtpUsername').value, password: $('#smtpPassword').value, from: $('#smtpFrom').value };
  c.autoReply = { subject: $('#mailSubject').value, template: $('#mailTemplate').value }; return c;
}

async function saveConfig() {
  const button = $('#saveConfig'); button.disabled = true;
  try { await api('/api/admin/config', { method: 'PUT', body: JSON.stringify(collectConfig()) }); $('#saveState').textContent = '已保存'; await loadState(); }
  catch (error) { $('#saveState').textContent = error.message; }
  finally { button.disabled = false; setTimeout(() => $('#saveState').textContent = '', 2500); }
}

async function generateKeys() {
  if (!confirm('生成新密钥会让旧私钥无法解密之后的新记录。确认继续？')) return;
  const pair = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 3072, publicExponent: new Uint8Array([1,0,1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
  const spki = await crypto.subtle.exportKey('spki', pair.publicKey); const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const privateBundle = JSON.stringify({ type: 'flower-garden-private-key', createdAt: new Date().toISOString(), algorithm: 'RSA-OAEP-256', privateKey: jwk }, null, 2);
  download(`flower-garden-private-key-${new Date().toISOString().slice(0,10)}.json`, privateBundle);
  $('#publicKeyInput').value = bufferToPem(spki, 'PUBLIC KEY');
  $('#saveState').textContent = '私钥已下载，请保存配置';
}

async function loadPrivateKey(file) {
  try { const bundle = JSON.parse(await file.text()); state.privateKey = await crypto.subtle.importKey('jwk', bundle.privateKey || bundle, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']); $('#keyStatus').textContent = '私钥只在此浏览器标签页内存中，未上传。现在可以解密记录。'; $('#keyStatus').classList.add('ready'); renderRecords(); }
  catch { $('#keyStatus').textContent = '无法读取这个私钥文件。'; }
}

async function decryptClaim(claim) {
  const e = claim.envelope; const rawKey = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, state.privateKey, base64ToBytes(e.wrappedKey));
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
  const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(e.iv) }, key, base64ToBytes(e.ciphertext));
  return JSON.parse(new TextDecoder().decode(clear));
}

async function inspectRecord(claim) {
  let data = { envelope: claim.envelope, plainMessage: claim.plainMessage, plainEmail: claim.plainEmail };
  if (state.privateKey) { try { data = await decryptClaim(claim); } catch (error) { alert(`解密失败：${error.message}`); return; } }
  $('#recordTitle').textContent = `${claim.flowerSpecies} · ${new Date(claim.createdAt).toLocaleString()}`;
  $('#recordData').textContent = JSON.stringify(data, null, 2);
  $('#recordDialog').showModal();
}

$('#loginForm').addEventListener('submit', async event => { event.preventDefault(); try { await api('/api/admin/login', { method:'POST', body:JSON.stringify({ password:$('#password').value }) }); await loadState(); } catch(error) { $('#loginError').textContent=error.message; } });
$$('.sidebar nav button').forEach(button => button.addEventListener('click', () => { $$('.sidebar nav button').forEach(b=>b.classList.remove('active')); $$('.tab').forEach(t=>t.classList.remove('active')); button.classList.add('active'); $(`#${button.dataset.tab}Tab`).classList.add('active'); $('#pageTitle').textContent = button.textContent === '概览' ? '花园概览' : button.textContent; }));
$('#saveConfig').addEventListener('click', saveConfig); $('#generateKeys').addEventListener('click', generateKeys);
$('#publicKeyFile').addEventListener('change', async e => { if(e.target.files[0]) $('#publicKeyInput').value = await e.target.files[0].text(); });
$('#privateKeyFile').addEventListener('change', e => { if(e.target.files[0]) loadPrivateKey(e.target.files[0]); });
$('#addFlower').addEventListener('click', () => { const n=state.db.config.flowers.length+1; state.db.config.flowers.push({id:`flower-${crypto.randomUUID()}`,species:'新花',icon:'✿',color:'#d58f86',title:`花园里的第 ${n} 朵花`,line:'写下一句只属于它的话。',note:'花期 · 未知',mediaFocus:'60% 50%'}); renderFlowers(); });
$('#logout').addEventListener('click', async()=>{await api('/api/admin/logout',{method:'POST'});location.reload()});
$('.dialog-close').addEventListener('click',()=>$('#recordDialog').close());
loadState();
