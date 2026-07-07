# Crawler DB Schema v2

## 목적

`crawled_notices` 단일 staging 테이블은 운영 검수에는 단순하지만, 다음 정보를 안정적으로 보존하기 어렵다.

- 같은 공지가 여러 게시판에서 발견된 경로
- 공유 게시판이 여러 학과/단과대에 대응되는 관계
- URL 변경, 같은 글의 재게시, 수정/삭제 이력
- 이미지/첨부파일의 원본 URL, 저장 위치, 해시, 추출 상태
- 실행별 성공률, audit 결과, 장애 원인

v2 스키마는 기존 `crawled_notices`를 즉시 제거하지 않고, 정규화된 운영 테이블을 병행 도입한다. 기존 관리자 검수 화면은 유지하면서 ingest v2가 준비되면 새 테이블을 채우고, 이후 화면/API를 단계적으로 전환한다.

SQL migration:

```text
sql/create-crawler-normalized-schema-v2.sql
```

## 핵심 엔티티

| 테이블 | 역할 |
| --- | --- |
| `crawler_notice_sources` | `data/notice-sources.csv`의 canonical source registry |
| `crawler_source_targets` | 하나의 게시판 source가 담당하는 `org_units` 다대다 관계 |
| `crawler_notices` | URL이 아니라 `canonical_key` 중심의 정규화 공지 |
| `crawler_notice_url_aliases` | 같은 공지의 URL 변경/별칭 이력 |
| `crawler_notice_occurrences` | 특정 source/run에서 어떤 URL로 발견됐는지에 대한 provenance |
| `crawler_notice_targets` | 공지가 실제로 적용되는 `org_units` 다대다 관계 |
| `crawler_notice_assets` | 이미지/첨부파일의 원본 URL, 저장소, 해시, 추출 상태 |
| `crawler_keyword_matches` | 키워드/규칙 기반 장학 후보 판정 근거 |
| `crawler_runs` | daily/baseline/audit/manual/backfill 실행 단위 |
| `crawler_source_results` | 실행별 source 결과와 카운트 |
| `crawler_audit_results` | capability audit decision/evidence 이력 |
| `crawler_errors` | 수집, ingest, asset, audit 단계의 구조화 오류 |

## 설계 기준

- URL은 영구 식별자가 아니다. `crawler_notices.canonical_key`를 정규화 공지의 기본 identity로 사용하고, URL은 `canonical_url`, `crawler_notice_url_aliases`, `crawler_notice_occurrences.discovered_url`에 보존한다.
- source와 org_unit은 다대다다. 공유 게시판은 `crawler_source_targets`로 표현한다.
- notice와 org_unit도 다대다다. 같은 공지가 여러 학과/단과대에 적용될 수 있으므로 `crawler_notice_targets`를 둔다.
- notice와 발견 경로는 분리한다. 같은 notice가 여러 source에서 발견되면 `crawler_notices` 1행과 `crawler_notice_occurrences` 여러 행으로 저장한다.
- asset URL 추출과 파일 저장은 별개다. `crawler_notice_assets.status`로 `referenced`, `stored`, `extracted`, `failed`, `ignored`를 구분한다.
- run/audit/error는 시계열이다. 최신 상태만 source row에 덮어쓰지 않고, 실행별 history를 별도 테이블에 남긴다.

## 기존 테이블과의 관계

`crawled_notices`는 당분간 staging/admin review 테이블로 유지한다.

전환 순서:

1. `create-crawler-normalized-schema-v2.sql`을 적용한다.
2. `data/notice-sources.csv`를 `crawler_notice_sources`와 `crawler_source_targets`에 적재하는 source sync 작업을 만든다.
3. `scripts/ingest-notices-to-supabase.mjs`를 v2 upsert/merge 방식으로 확장한다.
4. 기존 `crawled_notices` 적재는 compatibility mode로 유지하거나, v2에서 검수 화면이 필요한 projection을 만든다.
5. 관리자 화면이 v2 notice/occurrence/asset 정보를 읽게 전환되면 `crawled_notices` 의존도를 낮춘다.

## 고유키와 dedupe

- `crawler_notice_sources.source_key`: CSV `source_id`와 대응한다.
- `crawler_notices.canonical_key`: ingest가 결정하는 정규화 identity다.
- `crawler_notice_occurrences`: `source_id + md5(discovered_url)` 유니크다.
- `crawler_notice_url_aliases`: `notice_id + md5(url)` 유니크다.
- `crawler_notice_assets`: `notice_id + asset_kind + md5(source_url)` 유니크다.

`canonical_key` 생성 규칙은 ingest v2에서 버전 관리해야 한다. 권장 우선순위:

1. 공식 API/native post id가 있으면 `source-family:native-id`
2. 안정적인 detail URL이면 normalized URL hash
3. URL이 불안정하면 normalized title + posted_at + source family hash

## RLS

v2 crawler 테이블은 내부 운영 데이터다.

- service role ingest는 RLS를 우회한다.
- authenticated admin은 `public.is_admin()` 정책으로 조회/관리할 수 있다.
- public select는 열지 않는다. 공개 API가 필요해지면 별도 read model/view를 만든다.

## 후속 구현 체크리스트

- source sync: canonical CSV를 `crawler_notice_sources` / `crawler_source_targets`에 upsert
- ingest v2: `crawler_runs` 생성, source result 기록, notice/occurrence/target/keyword upsert
- canonical key helper: URL/native id/title-date hash 정책 버전 고정
- asset worker: 이미지/첨부파일 다운로드, MIME/sha256 검증, Storage 저장
- admin UI: occurrence/provenance/asset 상태 노출
- migration bridge: 기존 `crawled_notices`에서 v2로 backfill할지 여부 결정
