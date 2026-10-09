// /api/admin/links — 링크 장부 (로그인 필요)
//   GET                    → 장부 전체 + 링크별 누적 클릭·신청
//   POST { channel_id, crew_code, placement?, campaign?, label? } → 링크 만들기
//        같은 UTM 조합이 이미 있으면 새로 만들지 않고 기존 링크를 돌려준다(existing: true)
//   PATCH { id, archived?, label? } → 보관(숨기기)·메모 수정. 삭제는 하지 않는다.
const crypto = require('crypto');
const db = require('../_lib/db');
const h = require('../_lib/http');

// 📌 수정 포인트 D: 기본 캠페인 이름 (빌더에서 바꿀 수 있음)
const DEFAULT_CAMPAIGN = 'sju-test';
const LANDING_PATH = '/';

const SLUG = /^[a-z0-9._-]{1,60}$/;
const PLACEMENT = /^[a-z0-9-]{1,40}$/;

function todayKst() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(2, 10).replace(/-/g, ''); // YYMMDD
}

function shortCode() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789'; // 헷갈리는 글자(i l o 0 1) 제외
  const bytes = crypto.randomBytes(6);
  return Array.from(bytes, b => abc[b % abc.length]).join('');
}

function buildUrl(l) {
  const q = new URLSearchParams();
  q.set('utm_source', l.source);
  q.set('utm_medium', l.medium);
  q.set('utm_campaign', l.campaign);
  if (l.content) q.set('utm_content', l.content);
  if (l.term) q.set('utm_term', l.term);
  return `${l.landing_path}?${q.toString()}`;
}

const LINK_COLS = 'id,channel_id,crew_code,placement,landing_path,source,medium,campaign,content,term,url,short_code,label,clicks,last_clicked_at,archived,created_at';

module.exports = async function handler(req, res) {
  if (!h.guard(req, res)) return;
  try {
    if (req.method === 'GET') {
      const [links, stats] = await Promise.all([
        db.select('sju_links', `select=${LINK_COLS}&order=created_at.desc`),
        db.rpc('sju_admin_stats', { p_from: null, p_to: null }),
      ]);
      const signups = Object.fromEntries((stats.by_link || []).map(r => [r.id, r.signups]));
      return h.send(res, 200, {
        ok: true,
        default_campaign: DEFAULT_CAMPAIGN,
        links: links.map(l => ({ ...l, signups: signups[l.id] || 0 })),
      });
    }

    let b;
    try { b = await h.readJson(req); } catch (_) { return h.send(res, 400, { ok: false, error: 'bad_json' }); }

    if (req.method === 'POST') {
      if (typeof b.channel_id !== 'string' || !/^[0-9a-f-]{36}$/.test(b.channel_id)) {
        return h.send(res, 400, { ok: false, error: 'invalid_channel' });
      }
      const crewCode = String(b.crew_code || '');
      if (!/^cl[0-9]{2}$/.test(crewCode)) return h.send(res, 400, { ok: false, error: 'invalid_crew' });

      const [[channel], [crew]] = await Promise.all([
        db.select('sju_channels', `select=id,source,medium,placement,active&id=eq.${b.channel_id}`),
        db.select('sju_crews', `select=code,active&code=eq.${crewCode}`),
      ]);
      if (!channel || !channel.active) return h.send(res, 400, { ok: false, error: 'invalid_channel' });
      if (!crew || !crew.active) return h.send(res, 400, { ok: false, error: 'invalid_crew' });

      const placement = String(b.placement || channel.placement || '').trim().toLowerCase();
      if (!PLACEMENT.test(placement)) return h.send(res, 400, { ok: false, error: 'invalid_placement' });
      const campaign = String(b.campaign || DEFAULT_CAMPAIGN).trim().toLowerCase();
      if (!SLUG.test(campaign)) return h.send(res, 400, { ok: false, error: 'invalid_campaign' });

      const link = {
        channel_id: channel.id,
        crew_code: crew.code,
        placement,
        landing_path: LANDING_PATH,
        source: channel.source,
        medium: channel.medium,
        campaign,
        content: `${crew.code}_${placement}_${todayKst()}`,
        term: null,
        label: typeof b.label === 'string' ? b.label.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) || null : null,
        created_by: crew.code,
      };
      link.url = buildUrl(link);

      // 같은 UTM 조합이 이미 있으면 그 링크를 돌려준다
      const existing = await db.select('sju_links',
        `select=${LINK_COLS}&landing_path=eq.${encodeURIComponent(link.landing_path)}&source=eq.${link.source}` +
        `&medium=eq.${link.medium}&campaign=eq.${link.campaign}&content=eq.${link.content}&term=is.null`);
      if (existing.length) return h.send(res, 200, { ok: true, existing: true, link: existing[0] });

      for (let i = 0; i < 5; i++) {
        try {
          const [created] = await db.insert('sju_links', { ...link, short_code: shortCode() });
          return h.send(res, 200, { ok: true, existing: false, link: created });
        } catch (e) {
          const msg = e.body && (e.body.message || '');
          if (e.body && e.body.code === '23505' && /short_code/.test(msg)) continue; // 코드 겹침 → 다시
          if (e.body && e.body.code === '23505') { // 동시에 같은 조합을 만든 경우
            const again = await db.select('sju_links', `select=${LINK_COLS}&url=eq.${encodeURIComponent(link.url)}`);
            if (again.length) return h.send(res, 200, { ok: true, existing: true, link: again[0] });
          }
          throw e;
        }
      }
      return h.send(res, 500, { ok: false, error: 'code_generation_failed' });
    }

    if (req.method === 'PATCH') {
      if (typeof b.id !== 'string' || !/^[0-9a-f-]{36}$/.test(b.id)) return h.send(res, 400, { ok: false, error: 'invalid_id' });
      const patch = {};
      if ('archived' in b) patch.archived = !!b.archived;
      if ('label' in b) patch.label = typeof b.label === 'string' ? b.label.trim().slice(0, 200) || null : null;
      const [updated] = await db.update('sju_links', `id=eq.${b.id}`, patch);
      return h.send(res, 200, { ok: true, link: updated });
    }

    return h.send(res, 405, { ok: false, error: 'method_not_allowed' });
  } catch (e) { return h.fail(res, e, 'links'); }
};
