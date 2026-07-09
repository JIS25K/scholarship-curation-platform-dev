# Crawler Controlled Sample Apply Phase 2 Failure Fix

## Purpose

This note records the Phase 2 controlled sample apply failure and the local-only hardening added before any retry.

This phase does not rerun real apply, does not execute cleanup SQL, does not connect to Supabase, and does not approve production/main Supabase use, full crawl, or real crawler-output ingest.

## Failure Summary

The user ran a separately approved controlled fixture apply against a personal dev Supabase database. The apply failed at URL alias persistence:

```text
crawler_notice_url_aliases upsert failed: there is no unique or exclusion constraint matching the ON CONFLICT specification
```

Root cause:

- Schema unique constraint: `unique (notice_id, url_hash)`
- Executor conflict target before this fix: `notice_id,source_id,url_hash`
- The executor conflict target did not match the DB unique constraint.

The same review also found that `crawler_notice_targets` should use the table primary key `notice_id,org_unit_id`, not `notice_id,org_unit_id,source_id`.

## Partial Write State

The user verified the partial write state in personal dev:

- `crawler_runs`: 1 row created
- `crawler_source_results`: 1 row created
- `crawler_notices`: 1 row created
- `crawler_notice_url_aliases`: 0 rows
- `crawler_notice_occurrences`: 0 rows
- `crawler_notice_targets`: 0 rows
- `crawler_notice_assets`: 0 rows
- `crawler_errors`: 0 rows
- `crawler_keyword_matches`: 0 rows

The user already completed cleanup. Codex did not run cleanup SQL and did not access the DB.

## Fixes

Executor:

```text
scripts/apply-crawler-controlled-sample-guarded.mjs
```

Changes:

- changed `crawler_notice_url_aliases` upsert target to `notice_id,url_hash`
- changed `crawler_notice_targets` upsert target to `notice_id,org_unit_id`
- added an explicit upsert conflict target manifest
- added local-only schema conflict preflight using `sql/create-crawler-normalized-schema-v2.sql`
- added `--check-conflicts` for DB-free validation
- added local-only failure report simulation via `--simulate-apply-failure-at`
- added failure report creation for apply errors when `--out` is present
- changed apply failure handling so a created `crawler_runs` row is marked `failed` when a later step fails and the update itself is possible

Package script:

```text
crawler:apply:controlled-sample:check
```

Compatibility wrapper:

```text
scripts/run-crawler-guarded-apply-rehearsal.mjs
```

This wrapper forwards to the existing dry-run-only rehearsal planner.

## Failure Report Policy

When a future real apply fails after the local guards pass, the executor attempts to write a local JSON failure report to `--out`.

The failure report includes:

- `ok: false`
- `mode`
- `db_write_executed`
- `real_apply_executed`
- `failed_operation`
- `failed_table`
- `error_message`
- `partial_write_possible`
- `cleanup_required`
- `rehearsal_label`
- `source_key`
- `canonical_key`
- `completed_operations`
- `pending_operations`
- `guards`

The report is local-only and must remain outside commits when written under `reports/`.

## Run Status Policy

The executor now creates the run as part of the apply sequence and tracks completed operations. If a later step fails and a run row exists, it attempts to update that run to:

```text
status=failed
ended_at=<failure time>
metadata.failed_operation=<operation>
metadata.failed_table=<table>
metadata.error_message=<message>
```

This is best-effort failure marking. Cleanup remains a reviewed manual step and is not executed by Codex.

## Cleanup Review

Review-only cleanup draft:

```text
sql/drafts/crawler-guarded-sample-apply-cleanup.review.sql
```

The cleanup draft keeps `ROLLBACK` as the default and now scopes partial notices by:

- `crawler_runs.id`
- `metadata->>'rehearsal_label'`
- controlled `canonical_key` plus `metadata->>'controlled_sample' = 'true'`

This catches the Phase 2 partial write shape where run/source_result/notice existed but alias and later child rows did not.

## Retry Checklist

Before any future retry:

1. Run the local schema conflict preflight.
2. Generate a controlled fixture plan-only report.
3. Review the read-only DB comparison report from personal dev.
4. Confirm `reports/` outputs are not staged.
5. Confirm the cleanup SQL remains review-only and default `ROLLBACK`.
6. Confirm the user explicitly approves a personal-dev controlled sample write.

## NO-GO

Still prohibited:

- real apply retry without explicit user approval
- production/main Supabase
- full crawl
- real crawler-output ingest
- notice ingest apply
- cleanup SQL execution by Codex
- printing `.env`, Supabase URL, service role key, or secrets

## Phase 3 Audit Readiness

The controlled sample retry later succeeded in personal dev, and the follow-up audit/readiness record is documented in:

```text
docs/crawler-controlled-sample-apply-phase3-audit-readiness.md
```

Phase 3 also fixes the success-report inconsistency where top-level `real_apply_executed=true` but nested `go_no_go.real_apply_executed=false`.
