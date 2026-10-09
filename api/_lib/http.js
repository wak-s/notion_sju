// 어드민 API 공통: 응답, 본문 읽기, 같은 사이트 요청인지, 로그인 쿠키 확인
const crypto = require('crypto');

const COOKIE = 'sju_admin';
// 📌 수정 포인트 B: 로그인 유지 시간(시간 단위)
const SESSION_HOURS = 12;

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 20000) throw new Error('too_large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

// 상태를 바꾸는 요청은 이 사이트 화면에서 보낸 것만 받는다
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return req.method === 'GET';
  try { return new URL(origin).host === req.headers.host; } catch (_) { return false; }
}

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.headers['x-real-ip'] || 'unknown';
}

function ipHash(req) {
  const salt = process.env.SUPABASE_JWT_SECRET || process.env.SUPABASE_URL || 'sju';
  return crypto.createHmac('sha256', salt).update(clientIp(req)).digest('hex');
}

// 세션 서명 키: 비밀번호가 바뀌면 키도 바뀌어서 기존 로그인이 모두 풀린다
function signingKey() {
  const base = process.env.ADMIN_SESSION_SECRET || process.env.SUPABASE_JWT_SECRET || '';
  const pw = process.env.ADMIN_PASSWORD || '';
  if (!base || !pw) return null;
  return crypto.createHash('sha256').update(`${base}|${pw}`).digest();
}

function makeSession() {
  const key = signingKey();
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  return { value: `${payload}.${sig}`, maxAge: SESSION_HOURS * 3600 };
}

function readCookie(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function isLoggedIn(req) {
  const key = signingKey();
  const v = readCookie(req, COOKIE);
  if (!key || !v || !v.includes('.')) return false;
  const [payload, sig] = v.split('.');
  const expect = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now(); } catch (_) { return false; }
}

function setSessionCookie(res, value, maxAge) {
  res.setHeader('Set-Cookie',
    `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`);
}

// 로그인·같은 사이트 확인을 한 번에. 통과 못 하면 응답까지 보내고 false
function guard(req, res) {
  if (!sameOrigin(req)) { send(res, 403, { ok: false, error: 'bad_origin' }); return false; }
  if (!isLoggedIn(req)) { send(res, 401, { ok: false, error: 'login_required' }); return false; }
  return true;
}

function fail(res, e, tag) {
  console.error(`[${tag}]`, e.message, e.body ? JSON.stringify(e.body).slice(0, 300) : '');
  if (e.message === 'missing_env') return send(res, 500, { ok: false, error: 'missing_env' });
  return send(res, 500, { ok: false, error: 'server_error' });
}

module.exports = {
  send, readJson, sameOrigin, ipHash, makeSession, isLoggedIn, setSessionCookie, guard, fail, signingKey,
};
