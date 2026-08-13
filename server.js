const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'garden';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const DB_BACKUP_FILE = path.join(DATA_DIR, 'db.json.bak');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'assets', 'uploads');
const DB_SCHEMA_VERSION = 2;
// JSON is capped globally; authenticated flower-image uploads use a separate binary cap.
const MAX_BODY = 128 * 1024;
const MAX_IMAGE_UPLOAD = 2 * 1024 * 1024;
const MAX_ENVELOPE_CIPHERTEXT = 32 * 1024;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sessions = new Map();
const loginAttempts = new Map();

const initialConfig = {
  gardenName: '月光花园',
  invitation: '我有一个花园，你可以看看。喜欢的话，就挑一朵走。',
  publicKey: '',
  allowPlainMessage: true,
  allowPlainEmail: true,
  autoReply: {
    subject: '你从月光花园带走了一朵花',
    template: '你好，\n\n谢谢你来过我的花园，也谢谢你带走了「{{flower}}」。\n\n你的留言我已经收到。愿这朵花替我陪你一会儿。\n\n——月光花园'
  },
  smtp: { host: '', port: 465, secure: true, username: '', password: '', from: '' },
  flowers: [
    { id: 'sunflower-1', species: '向日葵', icon: '✺', color: '#e2a93d', title: '朝向你的晴天', line: '你出现的时候，连沉默都有了明亮的方向。', note: '花期 · 盛夏', mediaFocus: '72% 45%', image: '/assets/flowers/sunflower.webp', preview: '/assets/flowers/sunflower-preview.webp' },
    { id: 'sunflower-2', species: '向日葵', icon: '✺', color: '#d79827', title: '慢一点也会抵达', line: '不是每一天都要发光，向着光走就很好。', note: '花期 · 盛夏', mediaFocus: '66% 52%', image: '/assets/flowers/sunflower.webp', preview: '/assets/flowers/sunflower-preview.webp' },
    { id: 'sunflower-3', species: '向日葵', icon: '✺', color: '#e7b84b', title: '把夏天装进口袋', line: '请收下这一小块晴朗，等阴天时再打开。', note: '花期 · 盛夏', mediaFocus: '74% 63%', image: '/assets/flowers/sunflower.webp', preview: '/assets/flowers/sunflower-preview.webp' },
    { id: 'sunflower-4', species: '向日葵', icon: '✺', color: '#c98b21', title: '不落幕的金色时刻', line: '愿所有热烈都有回声，所有等待都不被辜负。', note: '花期 · 盛夏', mediaFocus: '83% 48%', image: '/assets/flowers/sunflower.webp', preview: '/assets/flowers/sunflower-preview.webp' },
    { id: 'carnation-1', species: '康乃馨', icon: '✿', color: '#e9928f', title: '一朵认真盛开的温柔', line: '你不必总是坚强，柔软本身就有力量。', note: '花期 · 初秋', mediaFocus: '70% 48%', image: '/assets/flowers/carnation.webp', preview: '/assets/flowers/carnation-preview.webp' },
    { id: 'rose-1', species: '玫瑰', icon: '❀', color: '#d47283', title: '第一朵玫瑰，写给心动', line: '每次胡思乱想，世界会轻轻亮了一下。', note: '花期 · 七夕', mediaFocus: '70% 45%', image: '/assets/flowers/rose.webp', preview: '/assets/flowers/rose-preview.webp' },
    { id: 'rose-2', species: '玫瑰', icon: '❀', color: '#b65a70', title: '第二朵玫瑰，写给勇敢', line: '敢于靠近，也从容接受每一种答案。', note: '花期 · 七夕', mediaFocus: '65% 60%', image: '/assets/flowers/rose.webp', preview: '/assets/flowers/rose-preview.webp' },
    { id: 'daffodil-1', species: '水仙', icon: '✥', color: '#f2dfb2', title: '水面上的第一束光', line: '愿你在自己的倒影里，看见值得被珍惜的人。', note: '花期 · 月夜', mediaFocus: '68% 37%', image: '/assets/flowers/daffodil.webp', preview: '/assets/flowers/daffodil-preview.webp' },
    { id: 'daffodil-2', species: '水仙', icon: '✥', color: '#ead49a', title: '一封没有署名的清晨', line: '有些相遇不喧哗，却会让漫长的日子有了香气。', note: '花期 · 月夜', mediaFocus: '76% 48%', image: '/assets/flowers/daffodil.webp', preview: '/assets/flowers/daffodil-preview.webp' },
    { id: 'daffodil-3', species: '水仙', icon: '✥', color: '#f6e9c7', title: '留给归途的小灯', line: '无论走了多远，都为自己留一盏灯。', note: '花期 · 月夜', mediaFocus: '69% 64%', image: '/assets/flowers/daffodil.webp', preview: '/assets/flowers/daffodil-preview.webp' }
  ]
};

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function migrateDb(db) {
  if (Number(db.schemaVersion || 0) >= DB_SCHEMA_VERSION) return false;
  const defaults = new Map(initialConfig.flowers.map(flower => [flower.id, flower]));
  const current = new Map(db.config.flowers.map(flower => [flower.id, flower]));
  const known = initialConfig.flowers.map(defaultFlower => {
    const flower = current.get(defaultFlower.id);
    if (!flower) return clone(defaultFlower);
    return {
      ...flower,
      title: defaultFlower.title,
      line: defaultFlower.line,
      image: flower.image || defaultFlower.image,
      preview: flower.preview || defaultFlower.preview
    };
  });
  const extra = db.config.flowers.filter(flower => !defaults.has(flower.id)).map(flower => ({
    ...flower,
    image: flower.image || '/assets/flowers/carnation.webp',
    preview: flower.preview || '/assets/flowers/carnation-preview.webp'
  }));
  db.config.flowers = [...known, ...extra];
  db.schemaVersion = DB_SCHEMA_VERSION;
  return true;
}

function readDbFile() {
  let db;
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (error) {
    throw new Error(`数据库文件无法解析：${DB_FILE}。为避免覆盖现有数据，服务已停止；请检查文件或从 ${DB_BACKUP_FILE} 恢复。`, { cause: error });
  }
  if (!db || typeof db !== 'object' || Array.isArray(db)
    || !db.config || typeof db.config !== 'object' || Array.isArray(db.config)
    || !Array.isArray(db.config.flowers) || !Array.isArray(db.claims)) {
    throw new Error(`数据库结构无效：${DB_FILE}。为避免覆盖现有数据，服务已停止；请检查文件或从 ${DB_BACKUP_FILE} 恢复。`);
  }
  return db;
}

function ensureDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    const db = { schemaVersion: DB_SCHEMA_VERSION, config: clone(initialConfig), claims: [] };
    writeDb(db);
    return db;
  }
  const db = readDbFile();
  let changed = migrateDb(db);
  // Remove the legacy attachment setting from databases created by earlier versions.
  if (Object.hasOwn(db.config, 'attachmentLimitKb')) {
    delete db.config.attachmentLimitKb;
    changed = true;
  }
  if (changed) writeDb(db);
  return db;
}

function readDb() {
  return ensureDb();
}

function writeDb(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  if (fs.existsSync(DB_FILE)) {
    fs.copyFileSync(DB_FILE, DB_BACKUP_FILE);
    fs.chmodSync(DB_BACKUP_FILE, 0o600);
  }
  fs.renameSync(tmp, DB_FILE);
}

function json(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...extraHeaders });
  res.end(body);
}

function publicConfig(db) {
  const { smtp, autoReply, ...rest } = db.config;
  return {
    ...rest,
    flowers: rest.flowers.map(f => ({ ...f, picked: db.claims.some(c => c.flowerId === f.id) })),
    pickedStories: db.claims.filter(c => c.plainMessage).map(c => ({
      flowerId: c.flowerId,
      message: c.plainMessage,
      pickedAt: c.createdAt
    }))
  };
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(v => v.trim().split('=').map(decodeURIComponent)).filter(v => v.length === 2));
}

function isAdmin(req) {
  const sid = parseCookies(req).garden_session;
  const session = sid && sessions.get(sid);
  return Boolean(session && session.expires > Date.now());
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
      reject(Object.assign(new Error('只接受 application/json 请求，不支持文件或表单上传'), { status: 415 }));
      return;
    }
    const chunks = []; let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('请求体过大'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('JSON 格式无效'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function readBinaryBody(req, max = MAX_IMAGE_UPLOAD) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > max) { reject(Object.assign(new Error('图片数据过大'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function cleanText(value, max = 4000) { return String(value || '').trim().slice(0, max); }

function cleanAssetPath(value, fallback = '') {
  const asset = cleanText(value, 300);
  return /^\/assets\/(?:flowers|uploads)\/[a-z0-9._-]+$/i.test(asset) ? asset : fallback;
}

function boundedText(value, field, max, { required = false, pattern } = {}) {
  if (value !== undefined && typeof value !== 'string') throw Object.assign(new Error(`${field}格式无效`), { status: 400 });
  const text = String(value || '').trim();
  if (required && !text) throw Object.assign(new Error(`${field}不能为空`), { status: 400 });
  if (text.length > max) throw Object.assign(new Error(`${field}不能超过 ${max} 个字符`), { status: 400 });
  if (text && pattern && !pattern.test(text)) throw Object.assign(new Error(`${field}格式不正确`), { status: 400 });
  return text;
}

function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return false;
  const allowedKeys = ['algorithm', 'ciphertext', 'iv', 'version', 'wrappedKey'];
  const keys = Object.keys(envelope).sort();
  if (keys.length !== allowedKeys.length || keys.some((key, index) => key !== allowedKeys[index])) return false;
  if (envelope.version !== 1 || envelope.algorithm !== 'RSA-OAEP-256+A256GCM') return false;
  const isBase64 = value => typeof value === 'string' && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
  return isBase64(envelope.iv) && envelope.iv.length === 16
    && isBase64(envelope.wrappedKey) && envelope.wrappedKey.length >= 300 && envelope.wrappedKey.length <= 1024
    && isBase64(envelope.ciphertext) && envelope.ciphertext.length >= 24 && envelope.ciphertext.length <= MAX_ENVELOPE_CIPHERTEXT;
}

function validateConfig(input, current) {
  const out = clone(current);
  out.gardenName = cleanText(input.gardenName, 60) || out.gardenName;
  out.invitation = cleanText(input.invitation, 240) || out.invitation;
  out.publicKey = cleanText(input.publicKey, 12000);
  out.allowPlainMessage = Boolean(input.allowPlainMessage);
  out.allowPlainEmail = Boolean(input.allowPlainEmail);
  if (input.autoReply) {
    out.autoReply.subject = cleanText(input.autoReply.subject, 160);
    out.autoReply.template = cleanText(input.autoReply.template, 6000);
  }
  if (input.smtp) {
    out.smtp = {
      host: cleanText(input.smtp.host, 200),
      port: Math.min(65535, Math.max(1, Number(input.smtp.port) || 465)),
      secure: true,
      username: cleanText(input.smtp.username, 300),
      password: input.smtp.password === '••••••••' ? current.smtp.password : cleanText(input.smtp.password, 500),
      from: cleanText(input.smtp.from, 300)
    };
  }
  if (Array.isArray(input.flowers) && input.flowers.length <= 80) {
    out.flowers = input.flowers.map((f, i) => ({
      id: cleanText(f.id, 80) || `flower-${i + 1}`,
      species: cleanText(f.species, 40) || '花',
      icon: cleanText(f.icon, 4) || '✿',
      color: /^#[0-9a-f]{6}$/i.test(f.color) ? f.color : '#e9928f',
      title: cleanText(f.title, 120), line: cleanText(f.line, 320), note: cleanText(f.note, 80),
      mediaFocus: /^\d{1,3}% \d{1,3}%$/.test(f.mediaFocus || '') ? f.mediaFocus : '60% 50%',
      image: cleanAssetPath(f.image, '/assets/flowers/carnation.webp'),
      preview: cleanAssetPath(f.preview, '/assets/flowers/carnation-preview.webp')
    }));
  }
  return out;
}

function smtpCommand(socket, command, expected) {
  return new Promise((resolve, reject) => {
    let response = '';
    const timeout = setTimeout(() => done(new Error('SMTP 响应超时')), 10000);
    function done(err) { clearTimeout(timeout); socket.off('data', onData); err ? reject(err) : resolve(response); }
    function onData(chunk) {
      response += chunk.toString();
      const lines = response.trimEnd().split(/\r?\n/);
      const last = lines[lines.length - 1] || '';
      if (/^\d{3} /.test(last)) {
        const code = Number(last.slice(0, 3));
        expected.includes(code) ? done() : done(new Error(`SMTP ${code}: ${last.slice(4)}`));
      }
    }
    socket.on('data', onData);
    if (command !== null) socket.write(`${command}\r\n`);
  });
}

function isWebP(buffer) {
  return buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
}

function removeUploadedAsset(assetPath) {
  if (!/^\/assets\/uploads\/[a-z0-9._-]+$/i.test(assetPath || '')) return;
  const file = path.join(PUBLIC_DIR, assetPath.slice(1));
  if (file.startsWith(`${UPLOAD_DIR}${path.sep}`)) fs.rmSync(file, { force: true });
}

async function sendMail(config, to, flower) {
  const s = config.smtp;
  if (!s.host || !s.from) return { status: 'skipped', detail: 'SMTP 未配置' };
  if (!s.secure) throw new Error('SMTP 配置不安全：仅支持 TLS 直连');
  const socket = tls.connect({ host: s.host, port: s.port, servername: s.host });
  await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
  try {
    await smtpCommand(socket, null, [220]);
    await smtpCommand(socket, `EHLO ${HOST}`, [250]);
    if (s.username) {
      await smtpCommand(socket, 'AUTH LOGIN', [334]);
      await smtpCommand(socket, Buffer.from(s.username).toString('base64'), [334]);
      await smtpCommand(socket, Buffer.from(s.password).toString('base64'), [235]);
    }
    await smtpCommand(socket, `MAIL FROM:<${s.from.match(/<([^>]+)>/)?.[1] || s.from}>`, [250]);
    await smtpCommand(socket, `RCPT TO:<${to}>`, [250, 251]);
    await smtpCommand(socket, 'DATA', [354]);
    const subject = config.autoReply.subject.replaceAll('{{flower}}', flower.species);
    const body = config.autoReply.template.replaceAll('{{flower}}', flower.species);
    const encodedSubject = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
    socket.write(`From: ${s.from}\r\nTo: ${to}\r\nSubject: ${encodedSubject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(body).toString('base64').match(/.{1,76}/g).join('\r\n')}\r\n.\r\n`);
    await smtpCommand(socket, null, [250]);
    await smtpCommand(socket, 'QUIT', [221]);
    return { status: 'sent', detail: '模板邮件已发送' };
  } finally { socket.end(); }
}

function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname === '/garden' ? 'index.html' : pathname === '/admin' ? 'admin.html' : pathname.slice(1);
  const file = path.resolve(PUBLIC_DIR, requested);
  if (!file.startsWith(`${PUBLIC_DIR}${path.sep}`) && file !== PUBLIC_DIR) return false;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const ext = path.extname(file);
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
  const cacheControl = ext === '.html' ? 'no-store' : requested.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': cacheControl, 'Content-Length': fs.statSync(file).size, 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
  return true;
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/config') return json(res, 200, publicConfig(readDb()));

  if (req.method === 'POST' && pathname === '/api/pick') {
    const body = await readBody(req); const db = readDb();
    const flowerId = boundedText(body.flowerId, '花朵编号', 80, { required: true });
    const flower = db.config.flowers.find(f => f.id === flowerId);
    if (!flower) return json(res, 404, { error: '这朵花不存在' });
    if (db.claims.some(c => c.flowerId === flower.id)) return json(res, 409, { error: '刚刚有人先一步带走了它' });
    if (!db.config.publicKey) return json(res, 503, { error: '花园主人还没有配置加密公钥' });
    if (!validateEnvelope(body.envelope)) return json(res, 400, { error: '加密信封格式或大小无效' });
    if (typeof body.shareMessage !== 'boolean' || typeof body.shareEmail !== 'boolean') return json(res, 400, { error: '明文授权字段格式无效' });
    const plainMessage = db.config.allowPlainMessage && body.shareMessage ? boundedText(body.plainMessage, '留言', 2000) : '';
    const plainEmail = db.config.allowPlainEmail && body.shareEmail ? boundedText(body.plainEmail, '邮箱', 254, { pattern: EMAIL_PATTERN }) : '';
    const claim = {
      id: crypto.randomUUID(), flowerId: flower.id, flowerSpecies: flower.species,
      createdAt: new Date().toISOString(), envelope: body.envelope,
      plainMessage, plainEmail, mail: { status: 'pending', detail: '' }
    };
    db.claims.push(claim); writeDb(db);
    if (plainEmail) {
      sendMail(db.config, plainEmail, flower).then(result => {
        const fresh = readDb(); const item = fresh.claims.find(c => c.id === claim.id);
        if (item) { item.mail = result; writeDb(fresh); }
      }).catch(error => {
        const fresh = readDb(); const item = fresh.claims.find(c => c.id === claim.id);
        if (item) { item.mail = { status: 'failed', detail: cleanText(error.message, 500) }; writeDb(fresh); }
      });
    } else { claim.mail = { status: 'skipped', detail: '未明文提供邮箱' }; writeDb(db); }
    return json(res, 201, { ok: true, flower: flower.species, claimId: claim.id });
  }

  if (req.method === 'POST' && pathname === '/api/admin/login') {
    const ip = req.socket.remoteAddress || 'unknown';
    const recent = (loginAttempts.get(ip) || []).filter(t => t > Date.now() - 10 * 60 * 1000);
    if (recent.length >= 8) return json(res, 429, { error: '尝试次数过多，请稍后再试' });
    const body = await readBody(req);
    if (!safeEqual(body.password || '', ADMIN_PASSWORD)) { recent.push(Date.now()); loginAttempts.set(ip, recent); return json(res, 401, { error: '口令不正确' }); }
    loginAttempts.delete(ip);
    const sid = crypto.randomBytes(32).toString('hex'); sessions.set(sid, { expires: Date.now() + 12 * 60 * 60 * 1000 });
    return json(res, 200, { ok: true }, { 'Set-Cookie': `garden_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` });
  }

  if (req.method === 'POST' && pathname === '/api/admin/logout') {
    const sid = parseCookies(req).garden_session; if (sid) sessions.delete(sid);
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'garden_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }

  if (pathname.startsWith('/api/admin/') && !isAdmin(req)) return json(res, 401, { error: '请先登录' });

  if (req.method === 'POST' && /^\/api\/admin\/flowers\/[^/]+\/image$/.test(pathname)) {
    const flowerId = decodeURIComponent(pathname.split('/')[4]);
    const previewLength = Number(req.headers['x-flower-preview-bytes']);
    if (!Number.isInteger(previewLength) || previewLength < 100 || previewLength > 128 * 1024) return json(res, 400, { error: '小预览图长度无效' });
    const payload = await readBinaryBody(req);
    const preview = payload.subarray(0, previewLength);
    const full = payload.subarray(previewLength);
    if (!isWebP(preview) || !isWebP(full)) return json(res, 415, { error: '图片必须由管理页转换为 WebP' });
    const db = readDb(); const flower = db.config.flowers.find(item => item.id === flowerId);
    if (!flower) return json(res, 404, { error: '这朵花不存在' });
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const key = crypto.randomUUID();
    const previewName = `${key}-preview.webp`; const fullName = `${key}.webp`;
    const previewFile = path.join(UPLOAD_DIR, previewName); const fullFile = path.join(UPLOAD_DIR, fullName);
    fs.writeFileSync(previewFile, preview, { mode: 0o644 });
    fs.writeFileSync(fullFile, full, { mode: 0o644 });
    const previousImage = flower.image; const previousPreview = flower.preview;
    flower.image = `/assets/uploads/${fullName}`;
    flower.preview = `/assets/uploads/${previewName}`;
    try { writeDb(db); }
    catch (error) { fs.rmSync(previewFile, { force: true }); fs.rmSync(fullFile, { force: true }); throw error; }
    removeUploadedAsset(previousImage); removeUploadedAsset(previousPreview);
    return json(res, 201, { ok: true, image: flower.image, preview: flower.preview });
  }

  if (req.method === 'GET' && pathname === '/api/admin/state') {
    const db = readDb(); const safe = clone(db); if (safe.config.smtp.password) safe.config.smtp.password = '••••••••';
    return json(res, 200, safe);
  }
  if (req.method === 'PUT' && pathname === '/api/admin/config') {
    const body = await readBody(req); const db = readDb();
    const previousAssets = db.config.flowers.flatMap(flower => [flower.image, flower.preview]);
    db.config = validateConfig(body, db.config); writeDb(db);
    const usedAssets = new Set(db.config.flowers.flatMap(flower => [flower.image, flower.preview]));
    previousAssets.filter(asset => !usedAssets.has(asset)).forEach(removeUploadedAsset);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && pathname === '/api/admin/export') {
    const body = JSON.stringify(readDb(), null, 2);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="flower-garden-${new Date().toISOString().slice(0, 10)}.json"` });
    return res.end(body);
  }
  if (req.method === 'DELETE' && pathname.startsWith('/api/admin/claims/')) {
    const id = decodeURIComponent(pathname.split('/').pop()); const db = readDb();
    const before = db.claims.length; db.claims = db.claims.filter(c => c.id !== id); writeDb(db);
    return json(res, before === db.claims.length ? 404 : 200, before === db.claims.length ? { error: '记录不存在' } : { ok: true });
  }
  return json(res, 404, { error: '接口不存在' });
}

ensureDb();
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'");
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    if (req.method === 'GET' && serveStatic(req, res, pathname)) return;
    json(res, 404, { error: '页面不存在' });
  } catch (error) {
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : '服务器暂时开小差了' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  月光花园已开放：http://${HOST}:${PORT}`);
  console.log(`  管理入口：http://${HOST}:${PORT}/admin`);
  if (ADMIN_PASSWORD === 'garden') console.log('  当前管理口令：garden（正式部署前请设置 ADMIN_PASSWORD）\n');
});
