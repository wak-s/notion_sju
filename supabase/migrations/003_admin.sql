-- ============================================================
-- 003 어드민: CL(크루) 표, 채널·링크에 게재영역/CL 칸, 기본 채널, 집계 함수
-- 여러 번 실행해도 안전하다.
-- ============================================================

-- 1) CL(링크를 발급·게시하는 사람)
create table if not exists public.sju_crews (
  code        text primary key check (code ~ '^cl[0-9]{2}$'),
  name        text not null check (char_length(name) between 1 and 20),
  active      boolean not null default true,
  sort        integer not null default 0,
  created_at  timestamptz not null default now()
);
insert into public.sju_crews (code, name, sort) values
  ('cl01', '시우', 1),
  ('cl02', '민지', 2)
on conflict (code) do nothing;

-- 2) 채널: 게재영역 기본값(비우면 링크 만들 때 직접 입력)
alter table public.sju_channels
  add column if not exists placement text check (placement ~ '^[a-z0-9-]{1,40}$');

-- 3) 링크: 누가(CL), 어디에(게재영역)
alter table public.sju_links
  add column if not exists crew_code text references public.sju_crews (code),
  add column if not exists placement text check (placement ~ '^[a-z0-9-]{1,40}$');

-- 4) 기본 채널 (UTM 설계 확정안, 2026-10-09)
insert into public.sju_channels (code, name, source, medium, placement, sort) values
  ('threads-post',    '스레드 본문',          'threads',   'post',      'post',  10),
  ('threads-bio',     '스레드 프로필',        'threads',   'bio',       'bio',   20),
  ('instagram-feed',  '인스타 피드',          'instagram', 'feed',      'feed',  30),
  ('instagram-story', '인스타 스토리',        'instagram', 'story',     'story', 40),
  ('instagram-bio',   '인스타 프로필',        'instagram', 'bio',       'bio',   50),
  ('kakao-openchat',  '카톡 오픈채팅·단톡',   'kakao',     'openchat',  null,    60),
  ('everytime',       '에브리타임',           'everytime', 'community', null,    70),
  ('offline-qrcode',  '오프라인 포스터 QR',   'offline',   'qrcode',    null,    80)
on conflict (code) do nothing;

-- 5) 집계: 기간 안의 클릭·신청을 링크별·일별(링크별로 나눠서)로 센다 (개인정보 없이 숫자만)
--    신청은 UTM 다섯 칸이 링크 장부와 똑같을 때 그 링크의 전환으로 센다.
--    p_from / p_to 가 null 이면 전체 기간.
create or replace function public.sju_admin_stats(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql stable security definer set search_path = public as $$
with s as (
  select id, created_at, utm_source, utm_medium, utm_campaign, utm_content, utm_term
    from sju_signups
   where status = 'active'
     and (p_from is null or created_at >= p_from)
     and (p_to   is null or created_at <  p_to)
),
sm as (
  select s.*, (
    select l.id from sju_links l
     where l.source = s.utm_source and l.medium = s.utm_medium and l.campaign = s.utm_campaign
       and coalesce(l.content, '') = coalesce(s.utm_content, '')
       and coalesce(l.term, '')    = coalesce(s.utm_term, '')
     order by l.created_at limit 1
  ) as link_id
  from s
),
c as (
  select link_id, clicked_at from sju_clicks
   where (p_from is null or clicked_at >= p_from)
     and (p_to   is null or clicked_at <  p_to)
),
by_link as (
  select l.id,
         (select count(*) from c  where c.link_id  = l.id) as clicks,
         (select count(*) from sm where sm.link_id = l.id) as signups
    from sju_links l
),
daily as (
  select d, link_id, sum(k)::int as clicks, sum(v)::int as signups from (
    select (clicked_at at time zone 'Asia/Seoul')::date as d, link_id, 1 as k, 0 as v from c
    union all
    select (created_at at time zone 'Asia/Seoul')::date, link_id, 0, 1 from sm where link_id is not null
  ) x group by d, link_id order by d
)
select jsonb_build_object(
  'summary', jsonb_build_object(
    'clicks',            (select count(*) from c),
    'signups_total',     (select count(*) from s),
    'signups_matched',   (select count(*) from sm where link_id is not null),
    'signups_utm_other', (select count(*) from sm where link_id is null and utm_source is not null),
    'signups_no_utm',    (select count(*) from sm where utm_source is null),
    'active_links',      (select count(*) from sju_links where archived = false)
  ),
  'by_link', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'clicks', clicks, 'signups', signups))
                         from by_link where clicks > 0 or signups > 0), '[]'::jsonb),
  'daily',   coalesce((select jsonb_agg(jsonb_build_object('date', d, 'link_id', link_id, 'clicks', clicks, 'signups', signups))
                         from daily), '[]'::jsonb)
);
$$;

-- 6) 보안
alter table public.sju_crews enable row level security;
revoke all on public.sju_crews from anon, authenticated;
revoke execute on function public.sju_admin_stats(timestamptz, timestamptz) from public, anon, authenticated;
grant  execute on function public.sju_admin_stats(timestamptz, timestamptz) to service_role;
