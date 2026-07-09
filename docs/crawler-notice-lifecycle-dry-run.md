# Crawler Notice Lifecycle Dry-Run Diagnostics

## Purpose

This diagnostic pass sits after collector-output adaptation and before any real notice ingest apply design. It classifies adapted crawler items into lifecycle buckets using local fixture data by default.

It is intentionally diagnostic-only:

- no DB write
- no Supabase SQL execution
- no crawler execution
- no notice ingest apply
- no source sync apply
- no crawler source target apply

## Command

```bash
node scripts/diagnose-crawler-notice-lifecycle-dry-run.mjs \
  --input fixtures/crawler-ingest-dry-run/adapted-collector-output-sample-sources.json \
  --out reports/lifecycle-dry-run-sample-source-output.json
```

JSON stdout:

```bash
node scripts/diagnose-crawler-notice-lifecycle-dry-run.mjs \
  --input fixtures/crawler-ingest-dry-run/adapted-collector-output-sample-sources.json \
  --out reports/lifecycle-dry-run-sample-source-output.json \
  --json
```

Synthetic diagnostics fixture:

```bash
node scripts/diagnose-crawler-notice-lifecycle-dry-run.mjs \
  --input fixtures/crawler-ingest-dry-run/lifecycle-diagnostics-synthetic-input.json \
  --out reports/lifecycle-dry-run-synthetic.json \
  --json
```

## Safety Boundary

Unsupported write-like options are rejected:

- `--apply`
- `--write`
- `--commit`

Read-only DB checks require all personal-dev guards:

- `--check-db`
- `--yes-i-am-using-personal-dev-db`
- `PERSONAL_DEV_SUPABASE_CONFIRM=1`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The script does not read `.env` files and must not print Supabase URL or key values.

## Local-Only Mode

Local-only mode never asserts that a notice already exists, changed, or stayed unchanged in DB. Items that are otherwise eligible carry `unknown_without_db_check` until the explicit personal-dev read-only DB check is run.

Local checks include:

- input source and item counts
- per-source item counts
- canonical notice keys
- duplicate canonical keys within input
- duplicate discovered URLs within input
- missing canonical URL
- missing discovered URL
- missing title
- missing published date
- empty body
- short body
- no assets
- item warnings and errors
- source-level warnings and errors

## Classification Buckets

| Classification | Meaning |
| --- | --- |
| `new_candidate` | Locally valid item with no local duplicate or quality blocker. DB existence is still unknown without `--check-db`. |
| `duplicate_within_input` | Same canonical key or discovered URL appears more than once in the current input. |
| `needs_quality_review` | Body or asset quality needs review before any real ingest design. |
| `blocked_by_missing_required_field` | Required local fields such as title or discovered URL are missing. |
| `blocked_by_schema` | Source or source target cannot be resolved in the selected diagnostic context. |
| `unchanged_candidate` | Only available after read-only DB comparison. |
| `changed_candidate` | Only available after read-only DB comparison. |
| `url_alias_candidate` | Only available after read-only DB comparison. |

## Read-Only DB Check

`--check-db` is optional and read-only. It only uses Supabase `.select(...).in(...)` reads against:

- `crawler_notice_sources`
- `crawler_source_targets`
- `crawler_notices`
- `crawler_notice_url_aliases`
- `crawler_notice_assets`

The DB check does not insert, update, upsert, delete, execute SQL, or call RPCs.

## Sample Source Output Result

Input:

```text
fixtures/crawler-ingest-dry-run/adapted-collector-output-sample-sources.json
```

Ignored report:

```text
reports/lifecycle-dry-run-sample-source-output.json
```

| Metric | Value |
| --- | ---: |
| sources | 3 |
| input_items | 4 |
| new_candidates | 0 |
| unchanged_candidates | 0 |
| changed_candidates | 0 |
| url_alias_candidates | 0 |
| duplicates_within_input | 0 |
| needs_quality_review | 4 |
| blocked_by_missing_required_field | 0 |
| blocked_by_schema | 0 |
| unknown_without_db_check | 4 |
| missing_sources | 0 |
| missing_source_targets | 0 |
| empty_body | 0 |
| short_body | 3 |
| no_assets | 4 |
| item_warnings | 7 |
| item_errors | 0 |

Source-level diagnostics:

- `cau_001`: `input_items=0`, source warnings `no_matched_scholarship_notices`, `no_adapter_items_for_ingest_dry_run`
- `cau_002`: `input_items=3`, `needs_quality_review=3`, `short_body=3`, `no_assets=3`
- `yonsei_060`: `input_items=1`, `needs_quality_review=1`, `no_assets=1`

## Synthetic Fixture Result

Input:

```text
fixtures/crawler-ingest-dry-run/lifecycle-diagnostics-synthetic-input.json
```

Ignored report:

```text
reports/lifecycle-dry-run-synthetic.json
```

| Metric | Value |
| --- | ---: |
| sources | 2 |
| input_items | 7 |
| new_candidates | 1 |
| unchanged_candidates | 0 |
| changed_candidates | 0 |
| url_alias_candidates | 0 |
| duplicates_within_input | 2 |
| needs_quality_review | 3 |
| blocked_by_missing_required_field | 1 |
| blocked_by_schema | 0 |
| unknown_without_db_check | 7 |
| missing_sources | 0 |
| missing_source_targets | 0 |
| empty_body | 1 |
| short_body | 1 |
| no_assets | 3 |
| item_warnings | 7 |
| item_errors | 0 |

The synthetic fixture covers:

- same canonical URL duplicate
- same title and published date alias-like candidate
- empty body
- short body
- no assets
- missing title and discovered URL

## Regression Checks

Validated paths:

- adapter synthetic-compatible path: `fixtures/crawler-ingest-dry-run/sample-notices.json`
- adapter adapted-real path: `fixtures/crawler-ingest-dry-run/adapted-real-sample.json`
- ingest dry-run path: `fixtures/crawler-ingest-dry-run/adapted-collector-output-sample-sources.json`

The ingest dry-run regression still reports:

- `planned_notices=4`
- `planned_url_aliases=4`
- `planned_occurrences=4`
- `planned_targets=4`
- `planned_assets=0`
- `schema_blockers=0`

## Go/No-Go

GO for the next dry-run-only phase:

- lifecycle diagnostics are available without DB access.
- source-level zero-item and warning cases remain visible.
- duplicate, quality, and missing-required-field cases are represented by committed fixtures.
- existing adapter and ingest dry-run paths still pass.

NO-GO for real ingest apply:

- sample items still need quality review.
- the sample output has no assets.
- local-only mode cannot prove existing, unchanged, changed, or URL alias state.
- no real write path has been designed or reviewed.

## Recommended Next Step

Recommended next step: design a read-only duplicate/change/delete planning report over personal-dev DB results, still without any real insert, update, delete, source sync apply, crawler source target apply, crawler execution, or notice ingest apply.
