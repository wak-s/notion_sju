// /l/코드 → (vercel.json 에서 /api/l?code=코드 로 연결)
// 클릭을 1 올리고 기록한 뒤, UTM이 붙은 내 랜딩으로 302 이동한다.
// - 항상 이 사이트 안으로만 보낸다(외부 주소로 보내지 않음).
// - 링크 미리보기 봇과 HEAD 요청은 세지 않는다.
// - 모르는 코드는 랜딩으로 보내되 utm_source=short-link&utm_medium=unknown 을 붙인다.
const db = require('./_lib/db');

const BOT_RE = /bot|crawler|spider|crawl|preview|facebookexternalhit|kakaotalk-scrap|twitterbot|slackbot|discordbot|telegrambot|whatsapp|yeti|daum|naver|embedly|quora|pinterest|vkshare|skypeuripreview|linkedinbot|headless|curl|wget|python-requests|go-http|okhttp/i;
const UNKNOWN = '/?utm_source=short-link&utm_medium=unknown';

function device(ua) {
  if (/mobile|android|iphone|ipad|ipod/i.test(ua)) return 'mobile';
  if (/windows|macintosh|linux|cros/i.test(ua)) return 'desktop';
  return 'other';
}

function refererHost(req) {
  try { return new URL(req.headers.referer).hostname.slice(0, 200); } catch (_) { return null; }
}

function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.end();
}

// 저장된 url 은 "/?utm_..." 형태. 혹시라도 / 로 시작하지 않으면(외부 주소) 쓰지 않는다.
function safePath(u) {
  return typeof u === 'string' && u.startsWith('/') && !u.startsWith('//') ? u : null;
}

module.exports = async function handler(req, res) {
  const code = String(new URL(req.url, 'http://x').searchParams.get('code') || '').toLowerCase();
  if (!/^[a-z0-9]{4,12}$/.test(code)) return redirect(res, UNKNOWN);

  const ua = String(req.headers['user-agent'] || '');
  const isBot = req.method === 'HEAD' || !ua || BOT_RE.test(ua);

  try {
    let url;
    if (isBot) {
      const rows = await db.select('sju_links', `select=url&short_code=eq.${code}&archived=eq.false`);
      url = rows[0] && rows[0].url;
    } else {
      url = await db.rpc('sju_register_click', { p_code: code, p_device: device(ua), p_referer_host: refererHost(req) });
    }
    return redirect(res, safePath(url) || UNKNOWN);
  } catch (e) {
    console.error('[l]', e.message);
    return redirect(res, UNKNOWN); // DB 문제가 있어도 방문자는 랜딩으로 보낸다
  }
};
