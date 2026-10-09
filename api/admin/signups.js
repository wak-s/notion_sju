// /api/admin/signups — 신청자 목록 (로그인 필요)
//   GET                                         → 신청자 목록 (최신순, 최대 2000건)
//   PATCH  { id, handling_status?, admin_note? } → 처리 상태·메모 바꾸기
//   DELETE { id, phone }                        → 영구 삭제 (전화번호를 한 번 더 맞춰야 지워짐)
// IP 해시·브라우저 정보는 화면에 필요 없어서 내보내지 않는다.
const db = require('../_lib/db');
const h = require('../_lib/http');

// 📌 수정 포인트 E: 처리 상태 종류 (화면 이름은 admin/index.html HANDLING 에서)
const HANDLING = ['new', 'contacted', 'in_progress', 'done', 'cancelled'];

const COLS = [
  'id', 'created_at', 'updated_at', 'submit_count', 'name', 'phone',
  'result_code', 'result_name', 'category', 'track', 'summary', 'want_setup', 'level', 'usage', 'role',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'referrer_host',
  'consent_marketing', 'consent_version', 'handling_status', 'admin_note', 'handled_at',
].join(',');

const UUID = /^[0-9a-f-]{36}$/;

module.exports = async function handler(req, res) {
  if (!h.guard(req, res)) return;
  try {
    if (req.method === 'GET') {
      const rows = await db.select('sju_signups', `select=${COLS}&status=eq.active&order=created_at.desc&limit=2000`);
      return h.send(res, 200, { ok: true, signups: rows });
    }

    let b;
    try { b = await h.readJson(req); } catch (_) { return h.send(res, 400, { ok: false, error: 'bad_json' }); }
    if (typeof b.id !== 'string' || !UUID.test(b.id)) return h.send(res, 400, { ok: false, error: 'invalid_id' });

    if (req.method === 'PATCH') {
      const patch = {};
      if ('handling_status' in b) {
        if (!HANDLING.includes(b.handling_status)) return h.send(res, 400, { ok: false, error: 'invalid_status' });
        patch.handling_status = b.handling_status;
        patch.handled_at = new Date().toISOString();
      }
      if ('admin_note' in b) {
        const note = typeof b.admin_note === 'string' ? b.admin_note.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim() : '';
        patch.admin_note = note ? note.slice(0, 500) : null;
      }
      if (!Object.keys(patch).length) return h.send(res, 400, { ok: false, error: 'nothing_to_update' });
      const [row] = await db.update('sju_signups', `id=eq.${b.id}`, patch);
      if (!row) return h.send(res, 404, { ok: false, error: 'not_found' });
      return h.send(res, 200, { ok: true, signup: { id: row.id, handling_status: row.handling_status, admin_note: row.admin_note, handled_at: row.handled_at } });
    }

    if (req.method === 'DELETE') {
      // 실수 방지: 지울 사람의 전화번호를 화면에서 한 번 더 입력받아 맞을 때만 지운다
      const phone = typeof b.phone === 'string' ? b.phone.trim() : '';
      if (!/^01[016789]-\d{3,4}-\d{4}$/.test(phone)) return h.send(res, 400, { ok: false, error: 'phone_mismatch' });
      const rows = await db.call('DELETE', `/sju_signups?id=eq.${b.id}&phone=eq.${encodeURIComponent(phone)}`, undefined, { Prefer: 'return=representation' });
      if (!rows || !rows.length) return h.send(res, 400, { ok: false, error: 'phone_mismatch' });
      return h.send(res, 200, { ok: true, deleted: 1 });
    }

    return h.send(res, 405, { ok: false, error: 'method_not_allowed' });
  } catch (e) { return h.fail(res, e, 'signups'); }
};
