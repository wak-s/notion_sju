// /api/admin/stats?from=ISO&to=ISO — 대시보드 숫자 (로그인 필요, 개인정보 없이 집계만)
const db = require('../_lib/db');
const h = require('../_lib/http');

function iso(v) {
  if (!v) return null;
  const d = new Date(String(v));
  return isNaN(d) ? undefined : d.toISOString();
}

module.exports = async function handler(req, res) {
  if (!h.guard(req, res)) return;
  if (req.method !== 'GET') return h.send(res, 405, { ok: false, error: 'method_not_allowed' });
  const url = new URL(req.url, 'http://x');
  const from = iso(url.searchParams.get('from'));
  const to = iso(url.searchParams.get('to'));
  if (from === undefined || to === undefined) return h.send(res, 400, { ok: false, error: 'invalid_range' });
  try {
    const [stats, links, channels, crews] = await Promise.all([
      db.rpc('sju_admin_stats', { p_from: from, p_to: to }),
      db.select('sju_links', 'select=id,channel_id,crew_code,placement,content,short_code,label,archived'),
      db.select('sju_channels', 'select=id,name'),
      db.select('sju_crews', 'select=code,name'),
    ]);
    return h.send(res, 200, { ok: true, from, to, ...stats, links, channels, crews });
  } catch (e) { return h.fail(res, e, 'stats'); }
};
