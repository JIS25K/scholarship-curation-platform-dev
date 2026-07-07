# Department Notice Crawler

학과 공지 페이지에서 장학 관련 공지(키워드 기반)만 자동 수집하는 스크립트입니다.

## 1) 입력 파일 준비

`data/notice-sources.csv`에 공지 목록 페이지 정보를 넣습니다. 이 파일이 audit와 운영
크롤러가 함께 사용하는 단일 canonical 설정입니다. 대학별 실행은 별도 CSV 파일이 아니라
`CRAWL_SOURCE_ID_PREFIX`로 제한합니다.

- 필수 컬럼: `source_id`, `source_name`, `list_url`
- 선택 컬럼:
  - `university_slug`: 대학 식별자(예: `korea`, `cau`). 비어 있으면 `source_id` 접두사로 추론
  - `university_id`: 온보딩 공통 마스터(`universities.id`) FK (legacy)
  - `college_id`: 온보딩 공통 마스터(`university_colleges.id`) FK (legacy)
  - `department_id`: 온보딩 공통 마스터(`university_departments.id`) FK (legacy)
  - `org_unit_id`: org_unit 트리(`org_units.id`) FK. `scripts/map-notice-sources-to-org-units.mjs`로
    일괄 매핑/갱신 (`--apply` 없이 실행하면 dry-run 리포트만 출력)
  - `base_url`: 상대 링크를 절대 링크로 변환할 때 기준 URL
  - `list_item_selector`: 공지 한 건을 감싸는 셀렉터 (예: `.board-list tbody tr`)
  - `link_selector`: 목록 아이템 내부의 상세 링크 셀렉터
  - `title_selector`: 목록 아이템 내부의 제목 셀렉터
  - `date_selector`: 목록 아이템 내부의 날짜 셀렉터
  - `detail_content_selector`: 상세 본문 셀렉터
  - `detail_date_selector`: 상세 날짜 셀렉터
  - `notice_url_pattern`: 상세 URL 필터 정규식
  - `keywords`: `|` 구분 키워드 목록
  - `college_name`: 소속 단과대
  - `department_name`: 학과/전공명. 비어 있으면 `source_name`에서 추론
  - `source_level`: 공지 계층. `university`(대학 본부) / `college`(단과대) / `department`(학과, 기본값)
  - `adapter`: 정적 HTML이 아닌 전용 수집기를 쓰는 소스 지정 (아래 `1-1` 참고)
  - `enabled`: `true/false`

## 1-1) 소스 계층(source_level)과 어댑터 소스

장학 공지는 한 대학 안에서도 세 계층에 흩어져 올라옵니다.

- `university`(대학 본부): 학생지원팀/장학팀 통합 공지. 교내·교외 장학 대부분이 모이는 원천에 가장 가까운 계층
- `college`(단과대): 단과대 행정실 공지
- `department`(학과): 학과·전공 게시판(기본값). 학과 한정 장학이 여기에만 있는 경우가 있음

`source_level`은 소스가 어느 계층인지 표시하는 메타데이터입니다. 같은 장학금이
본부→단과대→학과로 재게시되며 중복 수집될 수 있으므로, 검수 시 계층 우선순위
(`university` > `college` > `department`)로 대표 1건을 승격하는 기준으로 활용합니다.

중복 검수 기준(운영 규칙):

1. 1차: `notice_url` 동일 시 상위 레벨(`source_level`) 소스를 우선 승격
2. 2차: `normalized_title + notice_posted_at` 동일 시 상위 레벨 소스를 우선 검토
3. 자동 삭제는 하지 않고, 우선순위 추천만 제공한 뒤 사람이 최종 판단

일부 본부/포털 게시판은 목록을 정적 HTML이 아니라 **JSON API**로 제공하여
기본 cheerio 파서로는 수집되지 않습니다. 이런 소스는 `adapter` 컬럼에 전용
수집기 이름을 지정합니다.

- `cau_portal`: 중앙대 통합 CMS(`www.cau.ac.kr` `FR_CON`) 게시판.
  - `list_url`의 숨은 폼(`#sendForm`) 값을 그대로 `/ajax/FR_SVC/BBSViewList2.do`에
    POST하여 목록 JSON을 페이지 단위로 수집합니다.
  - 목록 JSON이 제목/게시일/부서/카테고리/식별자를 제공하므로 개별 상세 요청을
    생략합니다. 상세 링크는 `BoardView.do?...&BBS_SEQ=`로 구성합니다.
  - `list_url`의 탭(예: `CONTENTS_NO=5&P_TAB_NO=5` = 장학)이 카테고리를 이미
    한정하므로 사이트 구조를 하드코딩하지 않습니다.
  - 예시 소스: `cau_univ_001` (중앙대 학생지원팀 통합 장학 공지)

> 운영 주의: `www.cau.ac.kr` 본부 포털은 `...Bot` 형태의 User-Agent를 연결 종료로
> 차단합니다. `cau_portal` 어댑터는 이 때문에 일반 브라우저 User-Agent를 사용합니다.
> 새 어댑터 소스를 추가할 때도 대상 사이트의 robots.txt/이용약관을 확인하세요.

## 2) 로컬 실행

```bash
npm install
npm run crawl:notices
```

인자 지정 실행:

```bash
node scripts/crawl-scholarship-notices.mjs data/notice-sources.csv exports/notices .crawler/scholarship-notice-state.json
```

## 3) 출력

- `exports/notices/scholarship-notices-YYYYMMDD.json`: 실행 리포트 + 신규 공지 목록
- `exports/notices/scholarship-notices-latest.json`: 최신 실행 리포트
- `exports/notices/scholarship-notices-new-YYYYMMDD.csv`: 신규 장학 공지 CSV
  - 포함 컬럼: `university_slug`, `university_id`, `college_id`, `department_id`, `college_name`, `department_name`, `source_level`
- `.crawler/scholarship-notice-state.json`: 중복 방지 상태 파일

## 4) 최근 1개월 제한

기본값으로 최근 31일 이내 공지만 포함합니다.

- 날짜 파싱 소스: `detail_date_selector` > `date_selector` > 제목
- 지원 포맷: `YYYY-MM-DD`, `YYYY.MM.DD`, `YYYY/MM/DD`, `YYYY년 M월 D일`
- 날짜가 없는 공지는 기본 제외

환경변수:

- `CRAWL_LOOKBACK_DAYS=31` (기본값)
- `CRAWL_ALLOW_UNDATED=true` (날짜 없는 공지도 포함)
- `CRAWL_SOURCE_CONCURRENCY=1` (소스 병렬 처리 수, 기본 1)
- `CRAWL_SOURCE_ID_PREFIX=ewha_` (`source_id` 접두사로 대상 소스 제한)
- `CRAWL_SOURCE_LEVEL=university|college|department` (`source_level`로 대상 소스 제한, 복수값 `,` 지원)
- `CRAWL_COLLEGE_NAME=경영대학` (`college_name`으로 대상 소스 제한, 복수값 `,` 지원)
- `CRAWL_IGNORE_SEEN=true` (중복 상태 무시하고 matched를 모두 new로 처리)
- `CRAWL_TIMEOUT_MS=30000` (요청 타임아웃, 기본 15000)
- `CRAWL_RETRY_COUNT=2` (요청 재시도 횟수, 기본 2)
- `CRAWL_RETRY_BACKOFF_MS=1200` (재시도 대기 시작값, 기본 1000)

운영 표준:

- `data/notice-sources.csv`를 단일 source of truth로 유지합니다. 대학별 `notice-sources-*.csv`
  파일은 과거 import/분석 산출물로만 취급하고, daily/baseline 운영 워크플로 입력으로
  사용하지 않습니다.
- 그룹별 실행 시 반드시 `CRAWL_SOURCE_ID_PREFIX`를 함께 지정해 소스 혼입을 방지합니다.
- 예시:
  - 중앙대: `cau_`
  - 이화여대: `ewha_`
  - 한양대: `hanyang_`
  - 홍익대: `hongik_`
  - 경희대: `khu_`
  - 고려대: `korea_`
  - 성균관대: `skku_`
  - 서울시립대: `uos_`
  - 연세대: `yonsei_`

## 5) 아침 자동 실행 (GitHub Actions)

워크플로 파일:

- Daily 업데이트: `.github/workflows/crawl-scholarship-notices.yml`
- Baseline 전체수집: `.github/workflows/crawl-scholarship-notices-baseline.yml`

Daily 워크플로:

- KST 오전 8시 자동 실행 (`UTC 23:00`)
- 중앙대/이화여대/한양대/홍익대/경희대/고려대/성균관대/서울시립대/연세대를
  단일 설정 파일과 prefix 필터로 각각 크롤링 후 정제
- Slack으로 **통합 1개 메시지** 전송
- 결과물은 workflow artifact(`scholarship-notice-daily`)로 업로드
- 수동 실행 시 옵션:
  - `fresh_start=true`: 기존 daily 상태 캐시를 무시하고 시작
  - `ignore_seen=true`: 이번 실행에서 `new` 필터를 건너뛰고 테스트

Baseline 워크플로:

- 수동 실행 + 주 1회 실행(월요일 아침 KST)
- 긴 lookback으로 전체 후보를 재수집
- 결과물은 workflow artifact(`scholarship-notice-baseline`)로 업로드

## 5-1) Supabase 자동 적재 (staging)

통합 CSV가 만들어진 뒤, 신규 공지를 Supabase `crawled_notices` staging 테이블에 적재합니다.

- 스크립트: `scripts/ingest-notices-to-supabase.mjs` (`npm run ingest:notices`)
- 중복 방지: `notice_url` UNIQUE + `upsert(ignoreDuplicates)` → 이미 검수/승격된 행은 **절대 덮어쓰지 않음**
- 적재된 행은 `status='new'` 상태로 들어가며, 어드민 검수 후 `scholarships`로 승격됩니다.
- 적재 요약(`ingest-summary-latest.json`)에 `sourceLevelCounts`, `duplicateCandidates`가 포함되어
  우선순위 검수(`university > college > department`) 대상을 빠르게 확인할 수 있습니다.

필요한 GitHub Secret (Settings → Secrets and variables → Actions):

- `SUPABASE_URL`: 프로젝트 URL (`https://<ref>.supabase.co`)
- `SUPABASE_SERVICE_ROLE_KEY`: **Service Role Key**. RLS를 우회하므로 절대 코드/클라이언트에 노출 금지. CI Secret으로만 사용.

로컬 테스트(DB 쓰기 없이 파싱만 확인):

```bash
INGEST_DRY_RUN=true node scripts/ingest-notices-to-supabase.mjs exports/notices/daily/scholarship-notices-daily-latest.csv
```

### v2 정규화 스키마

`crawled_notices`는 현재 관리자 검수 호환을 위한 staging 테이블로 유지합니다. 운영형 provenance,
중복, 수정/삭제, 자산, 실행 이력 보존은 v2 스키마에서 담당합니다.

- 설계 문서: `docs/crawler-db-schema-v2.md`
- migration: `sql/create-crawler-normalized-schema-v2.sql`
- 핵심 테이블: `crawler_notice_sources`, `crawler_notices`, `crawler_notice_occurrences`,
  `crawler_notice_targets`, `crawler_notice_assets`, `crawler_runs`

다음 ingest 전환 작업에서는 기존 `ignoreDuplicates` 중심 upsert 대신 v2 테이블에
source/run/notice/occurrence/target/asset을 각각 upsert하고, `crawled_notices`는 필요 시
검수 화면 compatibility projection으로 유지합니다.

## 5-2) 어드민 검수 + AI 초안 생성

어드민 메뉴 `수집 공지 검수`(`/admin/crawled-notices`)에서 `status='new'` 공지를 확인하고 장학금으로 승격합니다.

- `검수 후 등록`: 원문 공지 제목/본문/URL을 기반으로 장학금 등록 폼을 미리 채움
- `AI 초안 생성`: 수집된 본문을 LLM에 보내 지원금액, 신청기간, 자격요건, 제출서류 등을 `extracted_draft`에 저장하고 폼 기본값으로 반영
- 최종 등록 시 `scholarships`에 insert하고 원본 `crawled_notices`는 `status='promoted'` + `scholarship_id`로 연결

AI 초안 생성은 OpenAI 호환(`/chat/completions`)과 Anthropic Messages API를 지원합니다.  
Vercel 환경변수 또는 로컬 `.env`에 설정하세요.

- `LLM_API_KEY`: 필수. LLM Provider API Key
- `LLM_PROVIDER`: 선택. `openai` 또는 `anthropic` (미지정 시 자동 감지)
- `LLM_API_BASE`: 선택. OpenAI 기본 `https://api.openai.com/v1`, Anthropic 기본 `https://api.anthropic.com/v1`
- `LLM_MODEL`: 선택. 예) OpenAI `gpt-4o-mini`, Anthropic `claude-sonnet-5`

예시:

```bash
LLM_PROVIDER=anthropic
LLM_API_BASE=https://api.anthropic.com/v1
LLM_MODEL=claude-sonnet-5
```

```bash
LLM_API_BASE=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
```

## 6) 운영 팁

- 사이트 부하를 피하려고 상세 페이지 요청 사이에 짧은 지연이 있습니다.
- robots.txt / 사이트 이용약관을 확인하고 허용 범위 내에서만 사용하세요.
- 일부 사이트가 JS 렌더링 기반이면 Playwright 기반 수집기로 확장해야 합니다.

## 7) 품질 평가/회귀 감지

매일 배치 후 품질 평가 스크립트로 주요 지표를 계산합니다.

- 스크립트: `scripts/evaluate-crawl-quality.mjs` (`npm run evaluate:notices`)
- 출력:
  - `exports/notices/quality/quality-snapshot-YYYYMMDD.json`
  - `exports/notices/quality/quality-snapshot-latest.json`
- 핵심 지표:
  - `source_success_rate`
  - `precision_cleaned`
  - `false_positive_rate`
  - `daily_rows` 및 최근 중앙값 대비 급락 여부

환경변수(선택):

- `QUALITY_LOOKBACK_DAYS=7`
- `QUALITY_DAILY_DROP_RATIO=0.5`
- `QUALITY_SUCCESS_DROP_ABS=0.2`
- `QUALITY_CORE_GROUPS=cau,ewha,korea`

## 7-1) 소스 건강도(연속 실패) 평가

연속 실패 소스를 자동으로 추적해 우선 점검 대상을 뽑습니다.

- 스크립트: `scripts/evaluate-source-health.mjs` (`npm run evaluate:source-health`)
- 출력: `exports/notices/quality/source-health-latest.json`
- 기본 규칙: 최근 7일 기준 동일 소스가 3일 이상 연속 실패 시 candidate로 분류

환경변수(선택):

- `HEALTH_LOOKBACK_DAYS=7`
- `HEALTH_CONSECUTIVE_ERROR_THRESHOLD=3`

## 8) 검수 피드백 루프

검수 결과(`promoted/rejected`, `review_note`)를 정기 집계해 정제 규칙/소스 튜닝에 반영합니다.

- 스크립트: `scripts/summarize-crawled-feedback.mjs` (`npm run feedback:notices`)
- 출력: `exports/notices/quality/review-feedback-latest.json`
- 거절 사유는 `review_note`의 `[tag]` 접두사 기준으로 집계됩니다.
  - 예: `[duplicate]`, `[not_scholarship]`, `[expired]`, `[insufficient_info]`

실행 전 준비:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

위 두 값은 아래 순서로 읽습니다.

1. 현재 셸 환경변수
2. `.env.local` (권장)
3. `.env.production`
4. `.env`

PowerShell 예시:

```powershell
$env:SUPABASE_URL="https://<project-ref>.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="<service-role-key>"
npm run feedback:notices
```
