// /api/admin/channels — 채널·CL 목록과 관리 (로그인 필요)
//   GET                         → { channels, crews }
//   POST  { kind:'channel', … } → 채널 추가      POST  { kind:'crew', code, name } → CL 추가
//   PATCH { kind:'channel', id, … } → 이름·게재영역·메모·표시 여부 수정 (source·medium은 수정 불가)
//   PATCH { kind:'crew', code, name?, active? }
const db = require('../_lib/db');
const h = require('../_lib/http');

const SLUG = /^[a-z0-9._-]{1,60}$/;
const PLACEMENT = /^[a-z0-9-]{1,40}$/;

function text(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

module.exports = async function handler(req, res) {
  if (!h.guard(req, res)) return;
  try {
    if (req.method === 'GET') {
      const [channels, crews] = await Promise.all([
        db.select('sju_channels', 'select=id,code,name,source,medium,placement,note,sort,active&order=sort.asc,created_at.asc'),
        db.select('sju_crews', 'select=code,name,active,sort&order=sort.asc,code.asc'),
      ]);
      return h.send(res, 200, { ok: true, channels, crews });
    }

    let b;
    try { b = await h.readJson(req); } catch (_) { return h.send(res, 400, { ok: false, error: 'bad_json' }); }

    if (req.method === 'POST' && b.kind === 'channel') {
      const row = {
        code: String(b.code || '').trim().toLowerCase(),
        name: text(b.name, 60),
        source: String(b.source || '').trim().toLowerCase(),
        medium: String(b.medium || '').trim().toLowerCase(),
        placement: b.placement ? String(b.placement).trim().toLowerCase() : null,
        note: text(b.note, 300),
        sort: Number.isInteger(b.sort) ? b.sort : 100,
      };
      if (!row.name) return h.send(res, 400, { ok: false, error: 'invalid_name' });
      if (![row.code, row.source, row.medium].every(v => SLUG.test(v))) return h.send(res, 400, { ok: false, error: 'invalid_slug' });
      if (row.placement && !PLACEMENT.test(row.placement)) return h.send(res, 400, { ok: false, error: 'invalid_placement' });
      try {
        const [created] = await db.insert('sju_channels', row);
        return h.send(res, 200, { ok: true, channel: created });
      } catch (e) {
        if (e.body && e.body.code === '23505') return h.send(res, 409, { ok: false, error: 'duplicate_code' });
        throw e;
      }
    }

    if (req.method === 'PATCH' && b.kind === 'channel') {
      if (typeof b.id !== 'string' || !/^[0-9a-f-]{36}$/.test(b.id)) return h.send(res, 400, { ok: false, error: 'invalid_id' });
      const patch = {};
      if ('name' in b) { patch.name = text(b.name, 60); if (!patch.name) return h.send(res, 400, { ok: false, error: 'invalid_name' }); }
      if ('placement' in b) {
        patch.placement = b.placement ? String(b.placement).trim().toLowerCase() : null;
        if (patch.placement && !PLACEMENT.test(patch.placement)) return h.send(res, 400, { ok: false, error: 'invalid_placement' });
      }
      if ('note' in b) patch.note = text(b.note, 300);
      if ('active' in b) patch.active = !!b.active;
      if ('sort' in b && Number.isInteger(b.sort)) patch.sort = b.sort;
      const [updated] = await db.update('sju_channels', `id=eq.${b.id}`, patch);
      return h.send(res, 200, { ok: true, channel: updated });
    }

    if (req.method === 'POST' && b.kind === 'crew') {
      const code = String(b.code || '').trim().toLowerCase();
      const name = text(b.name, 20);
      if (!/^cl[0-9]{2}$/.test(code) || !name) return h.send(res, 400, { ok: false, error: 'invalid_crew' });
      try {
        const [created] = await db.insert('sju_crews', { code, name, sort: parseInt(code.slice(2), 10) });
        return h.send(res, 200, { ok: true, crew: created });
      } catch (e) {
        if (e.body && e.body.code === '23505') return h.send(res, 409, { ok: false, error: 'duplicate_code' });
        throw e;
      }
    }

    if (req.method === 'PATCH' && b.kind === 'crew') {
      const code = String(b.code || '');
      if (!/^cl[0-9]{2}$/.test(code)) return h.send(res, 400, { ok: false, error: 'invalid_crew' });
      const patch = {};
      if ('name' in b) { patch.name = text(b.name, 20); if (!patch.name) return h.send(res, 400, { ok: false, error: 'invalid_name' }); }
      if ('active' in b) patch.active = !!b.active;
      const [updated] = await db.update('sju_crews', `code=eq.${code}`, patch);
      return h.send(res, 200, { ok: true, crew: updated });
    }

    return h.send(res, 400, { ok: false, error: 'bad_request' });
  } catch (e) { return h.fail(res, e, 'channels'); }
};
