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

- sample source body quality can still be insufficient; absent assets are reported as risk evidence, not an automatic blocker when body text and DB comparison are clean.
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

## Read-Only DB Comparison Review - 2026-07-09

This review attempted the personal-dev read-only DB comparison path from the current Codex session. The code path is implemented, but the DB comparison was not executed in this session because the required Supabase environment variables were not present.

Environment presence check, without printing values:

| Variable | Status in this Codex session |
| --- | --- |
| `PERSONAL_DEV_SUPABASE_CONFIRM` | missing |
| `SUPABASE_URL` | missing |
| `SUPABASE_SERVICE_ROLE_KEY` | missing |

Guard rejection checks:

| Check | Result |
| --- | --- |
| `--check-db` without `--yes-i-am-using-personal-dev-db` | rejected with `Refusing DB check: --yes-i-am-using-personal-dev-db is required.` |
| `--check-db --yes-i-am-using-personal-dev-db` with only `PERSONAL_DEV_SUPABASE_CONFIRM=1` | rejected with `Refusing DB check: SUPABASE_URL is required.` |

Safety result:

- DB writes executed: `false`
- Supabase SQL writes executed: `false`
- source sync apply executed: `false`
- crawler source target apply executed: `false`
- notice ingest apply executed: `false`
- deletion apply executed: `false`
- secrets printed: `false`

Local-only regression still passes:

| Input | Mode | Summary |
| --- | --- | --- |
| `adapted-collector-output-sample-sources.json` | `local_only` | `sources=3`, `input_items=4`, `needs_quality_review=4`, `unknown_without_db_check=4`, `write_plan_operations=32` |
| `pre-apply-safety-synthetic-input.json` | `local_only` | `sources=4`, `input_items=9`, `duplicates_within_input=4`, `needs_quality_review=3`, `do_not_mark_deleted=3`, `write_plan_operations=74` |

Because `db_check.executed` remained `false`, sample source DB readiness and DB-backed classification changes are not asserted by this review. They require the command below to be rerun in a personal dev shell that has the required environment variables set.

```bash
PERSONAL_DEV_SUPABASE_CONFIRM=1 \
node scripts/plan-crawler-pre-apply-safety-dry-run.mjs \
  --input fixtures/crawler-ingest-dry-run/adapted-collector-output-sample-sources.json \
  --check-db \
  --yes-i-am-using-personal-dev-db \
  --out reports/pre-apply-safety-sample-source.readonly-db.verify.json \
  --json
```

Real ingest apply remains NO-GO after this review. The next gate is still a successful personal-dev read-only DB comparison report, followed by guarded apply design review, rollback/audit trail verification planning, and sample apply rehearsal preparation.

## Guarded Apply Rehearsal Preparation

The guarded apply rehearsal preparation package is documented in:

```text
docs/crawler-guarded-apply-rehearsal-plan.md
```

It adds:

- a dry-run-only rehearsal planner,
- guarded apply eligibility rules,
- review-only cleanup SQL draft,
- read-only audit verification SQL draft,
- future-only command templates.

This package still does not implement or execute real sample apply. A future personal-dev sample apply requires a separate prompt and explicit user approval.

## Guarded Apply Readiness Review

The follow-up readiness review is documented in:

```text
docs/crawler-guarded-apply-readiness-review.md
```

Current real sample source output remains insufficient for real apply under the older sample review:

- `cau_001` has no input item.
- `cau_002` has short bodies and no assets.
- `yonsei_060` has detail body and no assets; under the updated Roadmap Phase 3 policy, no-assets alone is not an automatic blocker, but the exact candidate still needs read-only DB comparison and remaining gate checks.

The first future DB write rehearsal should prefer a controlled fixture strategy so dependency completeness, rollback scoping, and audit trail checks can be reviewed before any real source-output apply.

## Roadmap Phase 1 - Gate 1 Controlled Sample Apply

The next preparation artifact is documented in:

```text
docs/crawler-roadmap-phase1-gate1-controlled-sample-apply-executor.md
```

It uses the controlled fixture:

```text
fixtures/crawler-ingest-dry-run/guarded-apply-controlled-sample-input.json
```

The Roadmap Phase 1 - Gate 1 executor is plan-only by default and keeps `db_write_executed=false`, `supabase_sql_executed=false`, and `real_apply_executed=false` unless a future command passes all personal-dev write guards. In the current preparation phase, only local plan generation and guard rejection are validated.
