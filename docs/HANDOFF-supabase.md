# 인수인계: 신청 저장을 Fillout → Supabase로 전환 (2026-10-09)

CX 설계 대화창에 이 문서를 그대로 붙여넣으면 됩니다.

## 지금 상태 한 줄
테스트 결과 화면의 [신청하기]가 Fillout 팝업 대신 **`/api/signup` → Supabase `sju_signups` 표**에 바로 저장한다. 주소에 붙은 UTM도 같이 저장된다.
작업은 **`supabase-signup` 브랜치**에만 있고, 실제 사이트(main, notion-sju.vercel.app)는 아직 그대로다.

- 미리보기 주소: https://notion-sju-git-supabase-signup-wak-s.vercel.app
- 실제 반영: GitHub에서 `supabase-signup` → `main` 으로 Pull Request를 만들어 합치면 끝

## 신청 한 건이 저장되는 흐름
1. 방문자가 `?utm_source=…&utm_medium=…` 붙은 주소로 들어옴 → 탭(sessionStorage)에 UTM 기억
2. 테스트 → 결과 화면 → 이름·전화번호·동의 → [신청하기]
3. 브라우저가 `POST /api/signup` 으로 JSON 전송
4. 서버(`api/signup.js`)가 검사 후 Supabase 함수 `sju_upsert_signup` 호출 → 저장
5. 응답 `{ ok: true, is_new: true|false }` → 결과 화면에 완료 문구

## 파일과 수정 포인트 (index.html)
| 위치 | 바꾸면 달라지는 것 |
|---|---|
| ③ `CONFIG` | `SIGNUP_API`(보낼 주소), `CONSENT_VERSION`(동의 문구 버전), `RETENTION`(보유 기간) |
| 결과 화면 `<section class="apply">` | 신청 칸 화면(이름·전화번호·동의 문구·버튼). **동의 문구를 고치면 `CONSENT_VERSION`도 새 이름으로** |
| 숨은 칸 `#inWebsite` | 봇 걸러내기용. 지우지 말 것 |
| ⑧ `buildSignupPayload` | 서버로 보내는 값. 왼쪽 이름 = DB 칸 이름 |
| ⑨ `SIGNUP_MESSAGES` | 보내는 중 / 완료 / 재신청 / 오류 문구 |

서버 쪽: `api/signup.js` 맨 위 **수정 포인트 A** = 신청 횟수 제한(지금: 같은 IP 10분에 5번).

## API 사용법: `POST /api/signup`
보내는 JSON:
```
name (필수, 20자), phone (필수, 010-1234-5678 형식),
consent_privacy (필수, true), consent_version (필수, 예: v1-20261009),
result_code, result_name, category, track, summary, want_setup(true/false),
level, usage, role,
utm_source, utm_medium, utm_campaign, utm_content, utm_term, referrer_host,
consent_marketing (선택, true/false — 지금 화면엔 체크박스 없음),
website (숨은 칸, 사람은 빈 값)
```
응답:
- `200 { ok: true, is_new: true }` 새 신청
- `200 { ok: true, is_new: false }` 같은 번호로 다시 신청 → 기존 행을 최신 결과로 갱신
- `400 invalid_name | invalid_phone | consent_required | invalid_consent_version | bad_json`
- `403 bad_origin` (다른 사이트에서 보낸 요청) · `429 too_many_requests` · `500 server_error`

## Supabase 표 (프로젝트 `notion-sju-db`, 서울)
| 표 | 내용 |
|---|---|
| `sju_signups` | 신청자. 같은 번호의 활성 신청은 1건(`submit_count`로 제출 횟수). UTM은 **처음 들어온 값 유지** |
| `sju_links` / `sju_clicks` / `sju_channels` | 단축 링크·클릭·채널 (아직 사용하는 화면 없음 — 링크 빌더·어드민 단계에서 사용) |
| `sju_rate_limits` | 신청 횟수 제한 기록 |

함수: `sju_upsert_signup`, `sju_register_click`, `sju_hit_rate_limit`.
SQL 원본: `supabase/migrations/001_init.sql`, `002_upsert_signup.sql`.

## 보안 상태
- 모든 표 RLS 켜짐, 브라우저 역할(anon/authenticated)은 읽기·쓰기·함수 실행 전부 불가 — 서버 API만 접근
- DB 키는 `api/signup.js`에서만 사용(Vercel 환경변수). 브라우저 코드에 키 없음
- IP는 원문이 아니라 해시로만 저장

## 환경변수 (Vercel–Supabase 연동이 자동 생성)
코드가 쓰는 것: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`(없으면 `SUPABASE_SERVICE_ROLE_KEY`), `SUPABASE_JWT_SECRET`(IP 해시용)

## 남은 테스트 데이터
- `sju_signups`: 이름 `QA테스트`, 전화 `010-0000-0000` 1행 (submit_count 2, utm threads/social/qa-test/claude-check)
- `sju_rate_limits`: 테스트 때 생긴 기록 몇 줄 (하루 지나면 자동 정리)
지울 때: Supabase SQL Editor에서 `delete from sju_signups where phone = '010-0000-0000';`

## CX 대화창에서 정할 것
1. 신청 칸 문구, 동의 문구(마케팅 수신 선택 체크박스를 둘지 → 두면 `consent_marketing: true/false` 보내기만 하면 저장됨)
2. 완료 화면 경험 (지금은 한 줄 문구)
3. CL이 신청자를 어디서 볼지: 어드민 목록 화면 / Supabase → 노션 동기화(Make)
4. GA 이벤트 이름 (테스트 시작 → 결과 → 신청)
5. 그다음: 단축 링크(`/l/코드`) + 링크 빌더 + 대시보드
