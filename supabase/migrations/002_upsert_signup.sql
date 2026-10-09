-- ============================================================
-- 신청 저장 함수: 같은 전화번호의 활성 신청이 있으면 갱신, 없으면 새로 만든다.
-- - 테스트 결과·동의 기록은 최신 값으로 바꾼다.
-- - UTM(유입 경로)은 처음 들어온 값을 지킨다(first-touch). 처음에 비어 있었을 때만 채운다.
-- - submit_count 로 몇 번 제출했는지 센다.
-- 서버 API(service_role)만 실행할 수 있다.
-- ============================================================
create or replace function public.sju_upsert_signup(p jsonb)
returns table (id uuid, is_new boolean)
language plpgsql security definer set search_path = public as $$
begin
  return query
  insert into public.sju_signups as s (
    name, phone, result_code, result_name, category, track, summary, want_setup,
    level, usage, role,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term, referrer_host,
    consent_privacy, consent_marketing, consent_version, consent_at,
    ip_hash, user_agent
  ) values (
    p->>'name', p->>'phone', p->>'result_code', p->>'result_name', p->>'category',
    p->>'track', p->>'summary', (p->>'want_setup')::boolean,
    p->>'level', p->>'usage', p->>'role',
    p->>'utm_source', p->>'utm_medium', p->>'utm_campaign', p->>'utm_content', p->>'utm_term',
    p->>'referrer_host',
    (p->>'consent_privacy')::boolean, coalesce((p->>'consent_marketing')::boolean, false),
    p->>'consent_version', now(),
    p->>'ip_hash', p->>'user_agent'
  )
  on conflict (phone) where status = 'active' do update set
    name              = excluded.name,
    result_code       = excluded.result_code,
    result_name       = excluded.result_name,
    category          = excluded.category,
    track             = excluded.track,
    summary           = excluded.summary,
    want_setup        = excluded.want_setup,
    level             = excluded.level,
    usage             = excluded.usage,
    role              = excluded.role,
    -- UTM 다섯 칸은 한 묶음: 처음 값이 하나도 없을 때만 새 값으로 채운다
    utm_source   = case when s.utm_source is null and s.utm_medium is null and s.utm_campaign is null
                        then excluded.utm_source   else s.utm_source   end,
    utm_medium   = case when s.utm_source is null and s.utm_medium is null and s.utm_campaign is null
                        then excluded.utm_medium   else s.utm_medium   end,
    utm_campaign = case when s.utm_source is null and s.utm_medium is null and s.utm_campaign is null
                        then excluded.utm_campaign else s.utm_campaign end,
    utm_content  = case when s.utm_source is null and s.utm_medium is null and s.utm_campaign is null
                        then excluded.utm_content  else s.utm_content  end,
    utm_term     = case when s.utm_source is null and s.utm_medium is null and s.utm_campaign is null
                        then excluded.utm_term     else s.utm_term     end,
    referrer_host     = coalesce(s.referrer_host, excluded.referrer_host),
    consent_privacy   = excluded.consent_privacy,
    consent_marketing = excluded.consent_marketing,
    consent_version   = excluded.consent_version,
    consent_at        = now(),
    ip_hash           = excluded.ip_hash,
    user_agent        = excluded.user_agent,
    submit_count      = s.submit_count + 1,
    updated_at        = now()
  returning s.id, (s.xmax = 0) as is_new;
end $$;

revoke execute on function public.sju_upsert_signup(jsonb) from public, anon, authenticated;
grant  execute on function public.sju_upsert_signup(jsonb) to service_role;
