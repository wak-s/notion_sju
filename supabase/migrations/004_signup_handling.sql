-- ============================================================
-- 004 신청자 처리: CL이 남기는 처리 상태·메모
-- (status 칸은 중복 방지용 active/cancelled 라서 따로 둔다)
-- 재신청(sju_upsert_signup)은 이 칸들을 건드리지 않으므로 처리 기록이 유지된다.
-- 여러 번 실행해도 안전하다.
-- ============================================================
alter table public.sju_signups
  add column if not exists handling_status text not null default 'new'
    check (handling_status in ('new', 'contacted', 'in_progress', 'done', 'cancelled')),
  add column if not exists admin_note text check (char_length(admin_note) <= 500),
  add column if not exists handled_at timestamptz;

create index if not exists sju_signups_handling_idx on public.sju_signups (handling_status);
