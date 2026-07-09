# Crawler Pre-Apply Safety Dry-Run

## Purpose

This pass strengthens the dry-run/report layer before any real crawler notice ingest apply design. It combines read-only comparison planning, change detection, provenance diagnostics, conservative missing visibility checks, source health, and write-plan reporting.

This is not a real ingest apply.

Safety boundary:

- DB writes executed: `false`
- Supabase SQL executed: `false`
- crawler execution: `false`
- source sync apply: `false`
- crawler source target apply: `false`
- deletion apply or inactive write: `false`
- real ingest apply implementation: `false`

## Command

Local-only sample source report:

```bash
node scripts/plan-crawler-pre-apply-safety-dry-run.mjs \
  --input fixtures/crawler-ingest-dry-run/adapted-collector-output-sample-sources.json \
  --out reports/pre-apply-safety-sample-source.verify.json \
  --json
```

Synthetic report:

```bash
node scripts/plan-crawler-pre-apply-safety-dry-run.mjs \
  --input fixtures/crawler-ingest-dry-run/pre-apply-safety-synthetic-input.json \
  --previous-run-input fixtures/crawler-ingest-dry-run/pre-apply-previous-run-synthetic.json \
  --source-health-input fixtures/crawler-ingest-dry-run/source-health-synthetic.json \
  --out reports/pre-apply-safety-synthetic.verify.json \
  --json
```

Package script:

```bash
npm run crawler:pre-apply:dry-run -- --input fixtures/crawler-ingest-dry-run/adapted-collector-output-sample-sources.json
```

## Read-Only DB Comparison

`--check-db` is optional and only runs after all personal-dev guards are present:

- `--yes-i-am-using-personal-dev-db`
- `PERSONAL_DEV_SUPABASE_CONFIRM=1`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The script does not read `.env` files and does not print URL or key values.

Read-only tables:

- `crawler_notice_sources`
- `crawler_source_targets`
- `crawler_notices`
- `crawler_notice_url_aliases`
- `crawler_notice_occurrences`
- `crawler_notice_assets`

Allowed DB operation shape: `.select(...).in(...)` only.

## Change Detection

Items can include:

- `title_changed`
- `body_changed`
- `content_hash_changed`
- `body_quality_improved`
- `body_quality_degraded`
- `published_at_changed`
- `canonical_url_changed`
- `discovered_url_alias_added`
- `asset_count_changed`
- `asset_url_changed`
- `warning_count_changed`
- `error_count_changed`
- `unchanged_content`
- `unknown_without_db_check`

Severity values:

- `low`
- `medium`
- `high`
- `unsafe`

Local-only mode keeps `unknown_without_db_check`; it does not claim DB existing, unchanged, changed, or alias state.

## Provenance Diagnostics

The report keeps provenance separate from canonical notice identity:

- duplicate canonical keys inside the current input
- duplicate discovered URLs
- duplicate canonical URLs
- duplicate title plus published date groups
- cross-source candidates
- URL alias candidates
- multi-target candidates
- occurrence candidates

The dry-run must not collapse shared-board evidence into one URL-only identity.

## Missing Visibility

Missing/deletion checks are dry-run classifications only. They never produce delete or inactive writes.

Conservative classifications:

- `still_visible`
- `potentially_missing`
- `missing_but_source_fetch_failed`
- `missing_but_pagination_incomplete`
- `missing_but_source_blocked`
- `missing_but_source_degraded`
- `needs_recheck`
- `do_not_mark_deleted`

Unsafe source health, fetch failures, 403/CAPTCHA/blocking, and pagination incomplete all block deletion judgment.

## Source Health

Source health tracks:

- fetched item count
- matched scholarship notice count
- output item count
- detail fetch success/failure count
- empty/short body count
- no assets and asset extraction count
- timeout and HTTP error count
- selector mismatch count
- pagination incomplete
- blocked/CAPTCHA/403
- source warnings/errors

Run quality values include:

- `healthy`
- `partial`
- `degraded`
- `blocked`
- `selector_mismatch`
- `network_failed`
- `pagination_incomplete`
- `unsafe_for_lifecycle_judgment`

Unsafe source health blocks update-like write-plan operations and missing/deletion judgments.

## Write Plan

The write plan is a report, not an executor. Every operation has `would_write: false`.

Operation types include:

- `insert_run`
- `insert_source_result`
- `insert_notice`
- `update_notice_metadata`
- `update_notice_body`
- `skip_update_due_to_low_quality`
- `skip_update_due_to_source_health`
- `add_url_alias`
- `insert_occurrence`
- `insert_notice_target`
- `insert_asset`
- `insert_error`
- `insert_keyword_match`
- `skip_missing_detection_due_to_source_health`
- `skip_missing_detection_due_to_pagination`
- `no_op_unchanged`

Local-only mode blocks concrete insert/update planning with `unknown_without_db_check` and marks review required.

## Sample Source Result

Input:

```text
fixtures/crawler-ingest-dry-run/adapted-collector-output-sample-sources.json
```

Report:

```text
reports/pre-apply-safety-sample-source.verify.json
```

Summary:

| Metric | Value |
| --- | ---: |
| sources | 3 |
| input_items | 4 |
| needs_quality_review | 4 |
| unknown_without_db_check | 4 |
| short_body | 3 |
| no_assets | 4 |
| source_health_unsafe | 1 |
| write_plan_operations | 32 |
| blocked_write_plan_operations | 28 |
| review_required_operations | 28 |

Source diagnostics:

- `cau_001`: degraded, no matched scholarship notices, unsafe for missing detection.
- `cau_002`: partial, 3 short-body/no-asset items.
- `yonsei_060`: partial, one detail body item but no assets.

## Synthetic Result

Input:

```text
fixtures/crawler-ingest-dry-run/pre-apply-safety-synthetic-input.json
```

Additional fixtures:

```text
fixtures/crawler-ingest-dry-run/pre-apply-previous-run-synthetic.json
fixtures/crawler-ingest-dry-run/pre-apply-current-run-synthetic.json
fixtures/crawler-ingest-dry-run/source-health-synthetic.json
```

Report:

```text
reports/pre-apply-safety-synthetic.verify.json
```

Summary:

| Metric | Value |
| --- | ---: |
| sources | 4 |
| input_items | 9 |
| new_candidates | 1 |
| duplicates_within_input | 4 |
| needs_quality_review | 3 |
| blocked_by_missing_required_field | 1 |
| unknown_without_db_check | 9 |
| empty_body | 1 |
| short_body | 3 |
| no_assets | 5 |
| source_health_unsafe | 3 |
| potentially_missing | 1 |
| needs_recheck | 2 |
| do_not_mark_deleted | 3 |
| write_plan_operations | 74 |
| blocked_write_plan_operations | 68 |
| review_required_operations | 68 |

Covered cases:

- unchanged content against previous run
- changed title/body/content hash
- body quality degraded
- URL alias-like duplicate canonical URL
- duplicate title plus published date
- cross-source shared-board discovered URL
- empty body
- short body
- no assets
- missing title and discovered URL
- healthy missing candidate
- blocked source
- pagination incomplete source
- degraded source

## Go / No-Go

GO for the next dry-run-only design phase:

- local-only pre-apply report is generated.
- sample source fixture is accepted.
- synthetic fixture covers change, duplicate, quality, source health, missing visibility, and write plan diagnostics.
- existing adapter, ingest dry-run, and lifecycle diagnostics paths remain separate.
- write plan remains report-only.

NO-GO for real ingest apply:

- sample source body/assets quality is still insufficient.
- source health can be unsafe.
- local-only mode cannot prove DB unchanged/changed/alias state.
- missing/deletion detection is conservative report-only.
- guarded apply design, rollback/audit trail planning, and personal-dev sample rehearsal are still required.

## Recommended Next Phase

Recommended order:

1. guarded apply design review
2. rollback and audit trail verification plan
3. personal dev DB sample apply rehearsal preparation

Add one gate before step 3: run personal-dev read-only DB comparison on the exact sample fixture and review the write plan report before any rehearsal design.
