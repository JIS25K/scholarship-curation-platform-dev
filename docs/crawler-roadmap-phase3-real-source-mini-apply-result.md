# Crawler Roadmap Phase 3 Real Source Mini Apply Result

## Status

Roadmap Phase 3 result: PASS.

Roadmap Phase 3 completed with a DB-backed, real source mini apply to personal dev only. The PASS candidate was selected only after read-only source availability confirmed that `yonsei_060` exists in personal-dev DB and has source-target coverage.

The previous `ewha_001` and `hongik_007` candidates remain excluded because the earlier read-only comparison found `missing_db_source` and `missing_published_at` blockers.

## DB-Backed Source Availability

Command:

```text
PERSONAL_DEV_SUPABASE_CONFIRM=1 node scripts/plan-crawler-source-targets.mjs --csv data/notice-sources.csv --check-db --yes-i-am-using-personal-dev-db --source-key cau_001,cau_002,yonsei_060 --json
```

Summary:

| Metric | Value |
| --- | ---: |
| selected_rows | 3 |
| ready_to_sync | 3 |
| missing_sources | 0 |
| missing_org_units | 0 |
| invalid_org_unit_ids | 0 |
| duplicate_source_org_pairs | 0 |

DB-backed source keys:

| Source key | source_id | org_unit_id | Availability |
| --- | ---: | ---: | --- |
| `cau_001` | 2 | 719 | present, source-target ready |
| `cau_002` | 3 | 720 | present, source-target ready |
| `yonsei_060` | 4 | 46 | present, source-target ready |

No arbitrary Supabase SQL was executed for this check. The existing read-only script queried `crawler_notice_sources(source_key,id)` and `org_units(id)`.

## Candidate Search

Preferred DB-backed keys were checked first: `cau_001,cau_002,yonsei_060`.

Limited live public crawl command:

```text
CRAWL_SOURCE_ID_ALLOWLIST=cau_001,cau_002,yonsei_060
CRAWL_MAX_ITEMS_PER_SOURCE=1
CRAWL_LOOKBACK_DAYS=3650
CRAWL_ALLOW_UNDATED=false
CRAWL_IGNORE_SEEN=true
CRAWL_SOURCE_CONCURRENCY=1
CRAWL_TIMEOUT_MS=10000
CRAWL_RETRY_COUNT=0
node scripts/crawl-scholarship-notices.mjs data/notice-sources.csv exports/notices/roadmap-phase3-db-backed-candidate .crawler/roadmap-phase3-db-backed-candidate-state.json
```

Result:

- sources: 3
- crawled: 3
- matched: 1
- new: 1
- only `cau_002` produced a live candidate
- `cau_002` live candidate had `published_at=2026-07-10`, but `body_length=17` and was `needs_quality_review`

One wider check against the same DB-backed keys was run with `CRAWL_MAX_ITEMS_PER_SOURCE=5`. It produced five `cau_002` candidates, all with short body text, so none was applied.

The selected PASS candidate reused existing real collector output from:

```text
fixtures/crawler-ingest-dry-run/collector-output-sample-sources.json
```

Exact mini-apply candidate fixture:

```text
fixtures/crawler-ingest-dry-run/roadmap-phase3-db-backed-pass-candidate.json
```

Adapter command:

```text
node scripts/adapt-collector-output-for-ingest-dry-run.mjs --input fixtures/crawler-ingest-dry-run/collector-output-sample-sources.json --source-key yonsei_060 --limit 1 --out fixtures/crawler-ingest-dry-run/roadmap-phase3-db-backed-pass-candidate.json --json --format auto
```

## Candidate Status

| Source key | Title | Published date | Canonical key | Body quality | Asset status | Source health | Source target coverage | DB comparison state | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `cau_002` | `[학부] 2026-2학기 교내장학금(보훈/국가시험지원/가족/중앙나래) 신청 안내` | `2026-07-10` | `cau_002:url:e93a2b573a92e5c2d205` | body length 17, short body | no assets | partial; safe for change/missing detection | org unit `720` | source/source-target known, but `needs_quality_review` | HOLD |
| `yonsei_060` | `[ALL] UIC Scholarship Application Announcement: 2026 Fall` | `2026-06-15` | `yonsei_060:url:4fd429ec0cff6626de70` | `detail_body`, body length 5398 | no assets, warning only | partial; safe for change/missing detection | org unit `46` | new candidate before apply; post-apply unchanged with DB match | PASS |

`no_assets` was not treated as an automatic blocker.

## Verification

Static checks:

```text
node --check scripts/apply-normalized-ingest-v2-guarded.mjs
node --check scripts/plan-crawler-pre-apply-safety-dry-run.mjs
node --check scripts/adapt-collector-output-for-ingest-dry-run.mjs
```

Local-only pre-apply command:

```text
node scripts/plan-crawler-pre-apply-safety-dry-run.mjs --input fixtures/crawler-ingest-dry-run/roadmap-phase3-db-backed-pass-candidate.json --out reports/roadmap-phase3-db-backed-pass-candidate.local.verify.json --json
```

Local-only summary:

| Metric | Value |
| --- | ---: |
| sources | 1 |
| input_items | 1 |
| new_candidates | 1 |
| needs_quality_review | 0 |
| blocked_by_schema | 0 |
| unknown_without_db_check | 1 |
| short_body | 0 |
| no_assets | 1 |
| blocked_write_plan_operations | 6 |

Personal-dev read-only comparison command:

```text
PERSONAL_DEV_SUPABASE_CONFIRM=1 node scripts/plan-crawler-pre-apply-safety-dry-run.mjs --input fixtures/crawler-ingest-dry-run/roadmap-phase3-db-backed-pass-candidate.json --check-db --yes-i-am-using-personal-dev-db --out reports/roadmap-phase3-db-backed-pass-candidate.readonly-db.verify.json --json
```

Read-only summary before apply:

| Metric | Value |
| --- | ---: |
| mode | read_only_db_check |
| ok | true |
| sources | 1 |
| input_items | 1 |
| new_candidates | 1 |
| needs_quality_review | 0 |
| blocked_by_schema | 0 |
| unknown_without_db_check | 0 |
| missing_sources | 0 |
| missing_source_targets | 0 |
| db_check.sources_checked | 1 |
| db_check.source_targets_checked | 1 |
| db_match.matched | false |
| blocked_write_plan_operations | 0 |

## Mini Apply

Mini apply executed: true.

Command, with secrets omitted:

```text
PERSONAL_DEV_SUPABASE_CONFIRM=1 node scripts/apply-normalized-ingest-v2-guarded.mjs --apply --yes-i-am-using-personal-dev-db --i-understand-this-writes-to-personal-dev-db --input fixtures/crawler-ingest-dry-run/roadmap-phase3-db-backed-pass-candidate.json --source-key yonsei_060 --limit 1 --rehearsal-label roadmap-phase3-db-backed-mini-apply-20260710-102900 --out reports/roadmap-phase3-db-backed-mini-apply.20260710-102900.json --json
```

Apply summary:

| Metric | Value |
| --- | ---: |
| ok | true |
| mode | apply |
| selected_items | 1 |
| planned_operations | 13 |
| would_write_operations | 13 |
| schema_conflict_mismatches | 0 |
| report_errors | 0 |
| real_apply_executed | true |
| db_write_executed | true |

Completed operations:

- `insert_run`
- `insert_source_result`
- `upsert_notice`
- `upsert_url_alias`
- `upsert_occurrence`
- `upsert_notice_target`
- `insert_keyword_match`
- `insert_error`
- `mark_run_succeeded_on_success`

Identifiers:

| Identifier | Value |
| --- | --- |
| rehearsal_label | `roadmap-phase3-db-backed-mini-apply-20260710-102900` |
| run_id | `e32af575-7aca-4164-a7c7-2c26c70973ed` |
| source_key | `yonsei_060` |
| canonical_key | `yonsei_060:url:4fd429ec0cff6626de70` |
| notice_id | not emitted by executor report; post-apply read-only check reports `notice_id_present=true` |
| occurrence_id | not emitted by executor report; post-apply read-only check reports `occurrence_count=1` |

Cleanup / rollback identifiers:

- rehearsal label: `roadmap-phase3-db-backed-mini-apply-20260710-102900`
- run_id: `e32af575-7aca-4164-a7c7-2c26c70973ed`
- source_key: `yonsei_060`
- canonical_key: `yonsei_060:url:4fd429ec0cff6626de70`
- discovered/canonical URL hash basis: `4fd429ec0cff6626de70`
- org_unit_id: `46`

No cleanup SQL was generated or executed.

## Post-Apply Sanity Check

Command:

```text
PERSONAL_DEV_SUPABASE_CONFIRM=1 node scripts/plan-crawler-pre-apply-safety-dry-run.mjs --input fixtures/crawler-ingest-dry-run/roadmap-phase3-db-backed-pass-candidate.json --check-db --yes-i-am-using-personal-dev-db --out reports/roadmap-phase3-db-backed-pass-candidate.post-apply.readonly-db.verify.json --json
```

Summary:

| Metric | Value |
| --- | ---: |
| unchanged_candidates | 1 |
| changed_candidates | 0 |
| blocked_by_schema | 0 |
| unknown_without_db_check | 0 |
| db_match.matched | true |
| db_match.notice_id_present | true |
| db_match.alias_count | 1 |
| db_match.occurrence_count | 1 |
| db_match.asset_count | 0 |

## Safety Confirmation

- Production/main Supabase accessed: false
- Cleanup SQL executed: false
- Arbitrary Supabase SQL executed: false
- Guarded executor report `supabase_sql_executed`: true
- DB writes executed outside mini apply: false
- Batch apply executed: false
- delete/deprecate/inactive/lifecycle judgment operations executed: false

The `supabase_sql_executed=true` value is the guarded executor report flag for the personal-dev write path. No raw SQL, cleanup SQL, SQL editor operation, production/main DB access, or broad/batch apply was used.

## Roadmap Phase 4

Roadmap Phase 4 Full crawl dry-run can begin next: yes.

Phase 4 was run after the successful Phase 3 mini apply and is documented in:

```text
docs/crawler-roadmap-phase4-full-crawl-dry-run-result.md
```

## Risks And Follow-Up

- `cau_002` remains useful for crawler coverage but not for mini apply until its detail body extraction improves beyond category/team text.
- `yonsei_060` PASS used existing real collector output rather than the same-turn live crawl because the live one-item crawl did not match a scholarship item for that source.
- Phase 5 can start from the Phase 4 output, but should begin as a full-output pre-apply/read-only plan, not a DB write.
