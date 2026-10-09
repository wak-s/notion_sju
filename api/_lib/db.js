// Supabase REST 호출 도우미 (서버 전용). 파일 이름이 _ 로 시작해서 주소(API)로 노출되지 않는다.
function cfg() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('missing_env');
  const headers = { 'Content-Type': 'application/json', apikey: key };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  return { base: `${url.replace(/\/$/, '')}/rest/v1`, headers };
}

async function call(method, path, body, extraHeaders = {}) {
  const { base, headers } = cfg();
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    const err = new Error(`supabase_${r.status}`);
    err.status = r.status;
    try { err.body = JSON.parse(text); } catch (_) { err.body = text.slice(0, 300); }
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

module.exports = {
  call,
  rpc: (fn, args) => call('POST', `/rpc/${fn}`, args),
  select: (table, query) => call('GET', `/${table}?${query}`),
  insert: (table, row) => call('POST', `/${table}`, row, { Prefer: 'return=representation' }),
  update: (table, query, patch) => call('PATCH', `/${table}?${query}`, patch, { Prefer: 'return=representation' }),
};
