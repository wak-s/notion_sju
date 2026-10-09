// ============================================================
// POST /api/signup  — 테스트 결과로 신청하기
// 브라우저(index.html)가 보낸 신청을 검사한 뒤 Supabase sju_signups 에 저장한다.
// DB 키는 이 서버 파일에서만 쓰고, 브라우저로는 절대 내보내지 않는다.
// 필요한 환경변수(Vercel–Supabase 연동이 자동으로 넣어 줌):
//   SUPABASE_URL, SUPABASE_SECRET_KEY(또는 SUPABASE_SERVICE_ROLE_KEY), SUPABASE_JWT_SECRET
// ============================================================
const crypto = require('crypto');

// 📌 수정 포인트 A: 신청 횟수 제한 — 같은 IP에서 WINDOW_SECONDS 동안 LIMIT 번까지
const RATE_LIMIT = 5;
const RATE_WINDOW_SECONDS = 600;

const PHONE_RE = /^01[016789]-\d{3,4}-\d{4}$/;
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

// 결과·답변 칸: 이름 → 최대 글자 수
const TEXT_FIELDS = {
  result_code: 40, result_name: 80, category: 80, track: 80,
  summary: 2000, level: 80, usage: 80, role: 80,
};

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

// 보이지 않는 제어 문자를 지우고, 앞뒤 공백 정리, 길이 제한
function cleanText(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

// UTM 규칙: 소문자, 영문·숫자·. _ - 만. 규칙에 안 맞으면 버린다(신청은 받는다).
function cleanUtm(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase().replace(/\s+/g, '-');
  return /^[a-z0-9._-]{1,100}$/.test(s) ? s : null;
}

function cleanHost(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return /^[a-z0-9.-]{1,200}$/.test(s) ? s : null;
}

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || 'unknown';
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 20000) throw new Error('too_large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function rpc(fn, args) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('missing_env');
  const headers = { 'Content-Type': 'application/json', apikey: key };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`; // 옛 형식(JWT) 키일 때만
  const r = await fetch(`${url.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers, body: JSON.stringify(args),
  });
  const text = await r.text();
  if (!r.ok) {
    const err = new Error(`supabase_${r.status}`);
    err.detail = text.slice(0, 300);
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { ok: false, error: 'method_not_allowed' });
  }

  // 다른 사이트에서 보낸 요청은 받지 않는다 (Origin 주소 = 이 사이트 주소)
  const origin = req.headers.origin;
  if (origin) {
    let originHost = '';
    try { originHost = new URL(origin).host; } catch (_) { /* 잘못된 Origin */ }
    if (originHost !== req.headers.host) return send(res, 403, { ok: false, error: 'bad_origin' });
  }

  let body;
  try { body = await readJson(req); } catch (_) {
    return send(res, 400, { ok: false, error: 'bad_json' });
  }
  if (!body || typeof body !== 'object') return send(res, 400, { ok: false, error: 'bad_json' });

  // 허니팟: 사람 눈엔 안 보이는 칸. 채워져 있으면 봇이므로 저장하지 않고 성공처럼 답한다.
  if (body.website) return send(res, 200, { ok: true, is_new: true });

  // 필수 값 검사
  const name = cleanText(body.name, 20);
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  if (!name) return send(res, 400, { ok: false, error: 'invalid_name' });
  if (!PHONE_RE.test(phone)) return send(res, 400, { ok: false, error: 'invalid_phone' });
  if (body.consent_privacy !== true) return send(res, 400, { ok: false, error: 'consent_required' });
  const consentVersion = typeof body.consent_version === 'string' && /^[a-z0-9._-]{1,40}$/.test(body.consent_version)
    ? body.consent_version : null;
  if (!consentVersion) return send(res, 400, { ok: false, error: 'invalid_consent_version' });

  const ip = clientIp(req);
  const salt = process.env.SUPABASE_JWT_SECRET || process.env.SUPABASE_URL || 'sju';
  const ipHash = crypto.createHmac('sha256', salt).update(ip).digest('hex');

  try {
    const allowed = await rpc('sju_hit_rate_limit', {
      p_key: `signup:${ipHash}`, p_limit: RATE_LIMIT, p_window_seconds: RATE_WINDOW_SECONDS,
    });
    if (allowed === false) return send(res, 429, { ok: false, error: 'too_many_requests' });

    const payload = {
      name, phone,
      want_setup: typeof body.want_setup === 'boolean' ? body.want_setup : null,
      consent_privacy: true,
      consent_marketing: body.consent_marketing === true,
      consent_version: consentVersion,
      referrer_host: cleanHost(body.referrer_host),
      ip_hash: ipHash,
      user_agent: cleanText(req.headers['user-agent'], 400),
    };
    for (const [k, max] of Object.entries(TEXT_FIELDS)) payload[k] = cleanText(body[k], max);
    for (const k of UTM_KEYS) payload[k] = cleanUtm(body[k]);

    const rows = await rpc('sju_upsert_signup', { p: payload });
    const row = Array.isArray(rows) ? rows[0] : rows;
    return send(res, 200, { ok: true, is_new: !!(row && row.is_new) });
  } catch (e) {
    console.error('[signup]', e.message, e.detail || '');
    return send(res, 500, { ok: false, error: 'server_error' });
  }
};
