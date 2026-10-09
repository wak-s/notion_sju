-- ============================================================
-- 세종이네 노션 테스트: 신청·UTM 링크·클릭 테이블
-- 모든 테이블은 sju_ 접두사로 다른 프로젝트와 분리한다.
-- 브라우저(anon/authenticated)는 아무 테이블에도 접근하지 못하고,
-- 서버 API만 service_role 키로 읽고 쓴다.
-- 이 파일은 여러 번 실행해도 안전하다(if not exists).
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- 1) 신청자 (1차 전환)
-- ------------------------------------------------------------
create table if not exists public.sju_signups (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- 신청자 정보
  name             text not null check (char_length(name) between 1 and 40),
  phone            text not null check (phone ~ '^01[0-9]-[0-9]{3,4}-[0-9]{4}$'),

  -- 테스트 결과 (index.html 수정 포인트 ⑧ buildApplyParams 와 같은 이름)
  result_code      text check (char_length(result_code) <= 40),
  result_name      text check (char_length(result_name) <= 80),
  category         text check (char_length(category) <= 80),
  track            text check (char_length(track) <= 80),
  summary          text check (char_length(summary) <= 2000),
  want_setup       boolean,
  level            text check (char_length(level) <= 80),
  usage            text check (char_length(usage) <= 80),
  role             text check (char_length(role) <= 80),

  -- 유입 경로
  utm_source       text check (char_length(utm_source) <= 100),
  utm_medium       text check (char_length(utm_medium) <= 100),
  utm_campaign     text check (char_length(utm_campaign) <= 100),
  utm_content      text check (char_length(utm_content) <= 100),
  utm_term         text check (char_length(utm_term) <= 100),
  referrer_host    text check (char_length(referrer_host) <= 200),

  -- 동의 기록 (필수: 개인정보 / 선택: 마케팅 수신)
  consent_privacy  boolean not null check (consent_privacy = true),
  consent_marketing boolean not null default false,
  consent_version  text not null check (char_length(consent_version) <= 40),
  consent_at       timestamptz not null default now(),

  -- 운영
  status           text not null default 'active' check (status in ('active', 'cancelled')),
  submit_count     integer not null default 1,
  ip_hash          text check (char_length(ip_hash) <= 128),
  user_agent       text check (char_length(user_agent) <= 400)
);

-- 같은 전화번호의 활성 신청은 한 건만 (다시 신청하면 API가 기존 행을 갱신)
create unique index if not exists sju_signups_phone_active_uq
  on public.sju_signups (phone) where status = 'active';
create index if not exists sju_signups_created_at_idx on public.sju_signups (created_at);
create index if not exists sju_signups_utm_idx
  on public.sju_signups (utm_source, utm_medium, utm_campaign, utm_content, utm_term);

-- ------------------------------------------------------------
-- 2) 채널 (UTM 빌더용)
-- ------------------------------------------------------------
create table if not exists public.sju_channels (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique check (code ~ '^[a-z0-9._-]{1,60}$'),
  name            text not null check (char_length(name) <= 60),
  source          text not null check (source ~ '^[a-z0-9._-]{1,60}$'),
  medium          text not null check (medium ~ '^[a-z0-9._-]{1,60}$'),
  content_mode    text not null default 'date' check (content_mode in ('none', 'serial', 'date', 'free')),
  content_prefix  text check (content_prefix ~ '^[a-z0-9._-]{0,40}$'),
  note            text check (char_length(note) <= 300),
  sort            integer not null default 0,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 3) 링크 장부 (단축 링크)
-- ------------------------------------------------------------
create table if not exists public.sju_links (
  id               uuid primary key default gen_random_uuid(),
  channel_id       uuid references public.sju_channels (id),
  landing_path     text not null default '/' check (landing_path ~ '^/[A-Za-z0-9/_.-]*$'),
  source           text not null check (source ~ '^[a-z0-9._-]{1,60}$'),
  medium           text not null check (medium ~ '^[a-z0-9._-]{1,60}$'),
  campaign         text not null check (campaign ~ '^[a-z0-9._-]{1,60}$'),
  content          text check (content ~ '^[a-z0-9._-]{1,100}$'),
  term             text check (term ~ '^[a-z0-9._-]{1,100}$'),
  url              text not null check (char_length(url) <= 1000),
  short_code       text not null unique check (short_code ~ '^[a-z0-9]{4,12}$'),
  label            text check (char_length(label) <= 200),
  created_by       text check (char_length(created_by) <= 60),
  clicks           integer not null default 0,
  last_clicked_at  timestamptz,
  archived         boolean not null default false,
  created_at       timestamptz not null default now()
);

-- 같은 UTM 조합은 장부에 한 번만
create unique index if not exists sju_links_utm_uq
  on public.sju_links (landing_path, source, medium, campaign, coalesce(content, ''), coalesce(term, ''));

-- ------------------------------------------------------------
-- 4) 클릭 기록
-- ------------------------------------------------------------
create table if not exists public.sju_clicks (
  id            bigint generated always as identity primary key,
  link_id       uuid not null references public.sju_links (id),
  clicked_at    timestamptz not null default now(),
  device        text not null default 'other' check (device in ('mobile', 'desktop', 'other')),
  referer_host  text check (char_length(referer_host) <= 200)
);
create index if not exists sju_clicks_link_time_idx on public.sju_clicks (link_id, clicked_at);

-- ------------------------------------------------------------
-- 5) 속도 제한 기록 (신청 API가 IP 해시 기준으로 사용)
-- ------------------------------------------------------------
create table if not exists public.sju_rate_limits (
  key           text not null,
  window_start  timestamptz not null,
  hits          integer not null default 0,
  primary key (key, window_start)
);

-- ============================================================
-- 함수
-- ============================================================

-- 단축 링크 클릭: 원자적으로 +1, 로그 남기고 이동할 url 반환.
-- 없는 코드거나 보관된 링크면 아무것도 반환하지 않는다.
create or replace function public.sju_register_click(
  p_code text, p_device text, p_referer_host text
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_id  uuid;
  v_url text;
begin
  update public.sju_links
     set clicks = clicks + 1, last_clicked_at = now()
   where short_code = p_code and archived = false
  returning id, url into v_id, v_url;

  if v_id is null then
    return null;
  end if;

  insert into public.sju_clicks (link_id, device, referer_host)
  values (
    v_id,
    case when p_device in ('mobile', 'desktop') then p_device else 'other' end,
    left(p_referer_host, 200)
  );
  return v_url;
end $$;

-- 속도 제한: 이번 창(window)의 횟수를 +1 하고, 한도 안이면 true.
create or replace function public.sju_hit_rate_limit(
  p_key text, p_limit integer, p_window_seconds integer
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_window timestamptz := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );
  v_hits integer;
begin
  insert into public.sju_rate_limits (key, window_start, hits)
  values (p_key, v_window, 1)
  on conflict (key, window_start) do update set hits = sju_rate_limits.hits + 1
  returning hits into v_hits;

  -- 오래된 기록 정리 (하루 지난 것)
  delete from public.sju_rate_limits where window_start < now() - interval '1 day';

  return v_hits <= p_limit;
end $$;

-- ============================================================
-- 보안: RLS 켜기 + 브라우저 역할 권한 회수
-- (service_role 은 RLS를 우회하므로 서버 API는 정상 동작)
-- ============================================================
alter table public.sju_signups     enable row level security;
alter table public.sju_channels    enable row level security;
alter table public.sju_links       enable row level security;
alter table public.sju_clicks      enable row level security;
alter table public.sju_rate_limits enable row level security;

revoke all on public.sju_signups, public.sju_channels, public.sju_links,
              public.sju_clicks, public.sju_rate_limits
  from anon, authenticated;

revoke execute on function public.sju_register_click(text, text, text) from public, anon, authenticated;
revoke execute on function public.sju_hit_rate_limit(text, integer, integer) from public, anon, authenticated;
grant  execute on function public.sju_register_click(text, text, text) to service_role;
grant  execute on function public.sju_hit_rate_limit(text, integer, integer) to service_role;
