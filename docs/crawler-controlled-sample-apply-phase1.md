# Crawler Controlled Sample Apply Phase 1

## Purpose

Phase 1 prepares a guarded executor for the first future controlled personal-dev DB write rehearsal.

This document and the related script do not approve a real DB write. The current phase only prepares:

- controlled fixture preflight checks,
- dependency-complete operation planning,
- personal-dev-only apply guards,
- read-only DB comparison commands,
- audit and cleanup review links.

Real DB write, notice ingest apply, cleanup SQL execution, production/main Supabase access, full crawl, and deletion/inactive apply remain prohibited in this phase.

## Executor

Script:

```text
scripts/apply-crawler-controlled-sample-guarded.mjs
```

Package script:

```bash
npm run crawler:apply:controlled-sample -- --help
```

Default behavior is `plan_only`. In plan-only mode the script does not create a Supabase client, does not execute SQL, and writes only a local JSON report when `--out` is provided.

Required arguments:

```text
--input <path>
--pre-apply-report <path>
--source-key <source_key>
--limit 1
--rehearsal-label <label>
--out <path>
--json
```

Future-only real apply additionally requires all of:

```text
--apply
--yes-i-am-using-personal-dev-db
--yes-run-controlled-sample-apply
--i-understand-this-writes-to-personal-dev-db
PERSONAL_DEV_SUPABASE_CONFIRM=1
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

The script must not print URL or key values. It reports only boolean guard status.

## Controlled Fixture

Fixture:

```text
fixtures/crawler-ingest-dry-run/guarded-apply-controlled-sample-input.json
```

Current fixture policy:

- `source_key=yonsei_060`
- exactly one item
- full body text
- one synthetic attachment asset
- explicit `controlled_apply_rehearsal_fixture` marker
- no missing title or discovered URL
- not real crawler output

## Dependency-Complete Operation Set

The minimum operation set for the first controlled sample lifecycle rehearsal is:

- `insert_run`
- `insert_source_result`
- `insert_notice`
- `insert_occurrence`
- `insert_notice_target`
- `insert_error`

The controlled fixture also exercises:

- `add_url_alias`
- `insert_notice_asset`
- `insert_keyword_match`

Child rows must not be treated as a complete rehearsal unless the parent run, source result, and notice operations are present.

## Read-Only DB Comparison

Run this only in a personal-dev shell. It is read-only and uses select queries only.

```bash
export PERSONAL_DEV_SUPABASE_CONFIRM=1
export SUPABASE_URL='personal dev Supabase URL'
export SUPABASE_SERVICE_ROLE_KEY='personal dev service role key'

node scripts/plan-crawler-pre-apply-safety-dry-run.mjs \
  --input fixtures/crawler-ingest-dry-run/guarded-apply-controlled-sample-input.json \
  --check-db \
  --yes-i-am-using-personal-dev-db \
  --out reports/pre-apply-safety-controlled-sample.readonly-db.verify.json \
  --json

unset PERSONAL_DEV_SUPABASE_CONFIRM
unset SUPABASE_URL
unset SUPABASE_SERVICE_ROLE_KEY
```

Do not paste or commit actual environment values.

## Plan-Only Command

This command is safe for the current preparation phase. It does not write to DB.

```bash
node scripts/apply-crawler-controlled-sample-guarded.mjs \
  --input fixtures/crawler-ingest-dry-run/guarded-apply-controlled-sample-input.json \
  --pre-apply-report reports/pre-apply-safety-controlled-sample.readonly-db.verify.json \
  --source-key yonsei_060 \
  --limit 1 \
  --rehearsal-label controlled-sample-phase1-YYYYMMDD \
  --out reports/controlled-sample-apply-plan.verify.json \
  --json
```

Expected safety fields:

- `db_write_executed=false`
- `supabase_sql_executed=false`
- `real_apply_executed=false`
- `summary.dependency_complete=true`

When the input pre-apply report is `local_only`, the plan is still generated, but real apply readiness remains blocked with `read_only_db_check_required`.

## Future-Only Apply Template

Do not run this command in the current phase.

```bash
# FUTURE ONLY - DO NOT RUN IN THIS STEP
export PERSONAL_DEV_SUPABASE_CONFIRM=1
export SUPABASE_URL='personal dev Supabase URL'
export SUPABASE_SERVICE_ROLE_KEY='personal dev service role key'

node scripts/apply-crawler-controlled-sample-guarded.mjs \
  --input fixtures/crawler-ingest-dry-run/guarded-apply-controlled-sample-input.json \
  --pre-apply-report reports/pre-apply-safety-controlled-sample.readonly-db.verify.json \
  --source-key yonsei_060 \
  --limit 1 \
  --rehearsal-label controlled-sample-phase1-YYYYMMDD \
  --out reports/controlled-sample-apply.executed.json \
  --json \
  --apply \
  --yes-i-am-using-personal-dev-db \
  --yes-run-controlled-sample-apply \
  --i-understand-this-writes-to-personal-dev-db

unset PERSONAL_DEV_SUPABASE_CONFIRM
unset SUPABASE_URL
unset SUPABASE_SERVICE_ROLE_KEY
```

Before running a future apply, the user must explicitly approve the write, verify that the DB is personal dev, and prepare immediate audit/cleanup review.

## Audit And Cleanup

Read-only audit draft:

```text
sql/drafts/crawler-guarded-sample-apply-audit-checks.review.sql
```

Cleanup review draft:

```text
sql/drafts/crawler-guarded-sample-apply-cleanup.review.sql
```

Both drafts are scoped by `crawler_runs.id` or `metadata->>'rehearsal_label'`. Cleanup keeps `ROLLBACK` as the default review behavior.

## Go / No-Go

GO for the next review gate:

- local plan-only report is generated,
- dependency-complete operation set is present,
- `--apply` is rejected without all confirmation/env guards,
- audit and cleanup SQL are reviewed,
- no DB write was executed in Codex.

NO-GO for real apply:

- read-only DB comparison is missing,
- production/main Supabase is involved,
- user has not explicitly approved a controlled personal-dev write,
- cleanup/audit review is not ready,
- deletion/inactive behavior is requested.

