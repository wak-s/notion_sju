// /api/admin/auth
//   GET    → 로그인 상태 확인
//   POST   → 로그인 { id, password }
//   DELETE → 로그아웃
// 아이디·비밀번호는 Vercel 환경변수 ADMIN_ID, ADMIN_PASSWORD 에만 있다(코드에 없음).
const crypto = require('crypto');
const db = require('../_lib/db');
const h = require('../_lib/http');

// 📌 수정 포인트 C: 로그인 시도 제한 — 같은 IP에서 10분에 LOGIN_LIMIT 번까지
const LOGIN_LIMIT = 10;

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    return h.send(res, 200, {
      ok: true,
      loggedIn: h.isLoggedIn(req),
      configured: !!(process.env.ADMIN_ID && h.signingKey()),
    });
  }
  if (!h.sameOrigin(req)) return h.send(res, 403, { ok: false, error: 'bad_origin' });

  if (req.method === 'DELETE') {
    h.setSessionCookie(res, '', 0);
    return h.send(res, 200, { ok: true });
  }
  if (req.method !== 'POST') return h.send(res, 405, { ok: false, error: 'method_not_allowed' });

  if (!process.env.ADMIN_ID || !h.signingKey()) {
    return h.send(res, 503, { ok: false, error: 'not_configured' });
  }

  let body;
  try { body = await h.readJson(req); } catch (_) { return h.send(res, 400, { ok: false, error: 'bad_json' }); }

  try {
    const allowed = await db.rpc('sju_hit_rate_limit', {
      p_key: `login:${h.ipHash(req)}`, p_limit: LOGIN_LIMIT, p_window_seconds: 600,
    });
    if (allowed === false) return h.send(res, 429, { ok: false, error: 'too_many_requests' });
  } catch (e) { return h.fail(res, e, 'auth'); }

  const idOk = safeEqual(body.id || '', process.env.ADMIN_ID);
  const pwOk = safeEqual(body.password || '', process.env.ADMIN_PASSWORD);
  if (!(idOk && pwOk)) return h.send(res, 401, { ok: false, error: 'wrong_credentials' });

  const s = h.makeSession();
  h.setSessionCookie(res, s.value, s.maxAge);
  return h.send(res, 200, { ok: true });
};
