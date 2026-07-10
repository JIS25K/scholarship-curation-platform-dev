# Crawler Guarded Apply Rehearsal Plan

## Purpose

This phase prepares guarded apply design, rollback/audit planning, and sample apply rehearsal commands. It does not run a real ingest apply and does not write to Supabase.

The current pre-apply safety and personal-dev read-only DB comparison results make the 8-10 preparation phase reasonable, but they do not make real sample apply automatically safe.

Current sample source reading:

- `cau_001`: not a sample apply candidate because `input_items=0` and no matched scholarship notices.
- `cau_002`: not an automatic notice insert candidate because all 3 items have `short_body` and `no_assets`.
- `yonsei_060`: has detail body and `no_assets`; under the updated Roadmap Phase 3 policy, no-assets alone is not an automatic blocker, but read-only DB comparison and remaining candidate gates are still required.

Real guarded sample apply remains NO-GO until the user explicitly approves a later step.

Follow-up readiness review:

```text
docs/crawler-guarded-apply-readiness-review.md
```

That review clarifies that `sample_apply_rehearsal_ready=true` means the dry-run planner found reviewable rehearsal candidates, not that real DB write is approved.

Roadmap Phase 1 - Gate 1 controlled sample executor preparation:

```text
docs/crawler-roadmap-phase1-gate1-controlled-sample-apply-executor.md
```

That document connects the controlled fixture, read-only DB comparison, plan-only apply report, future-only apply template, and audit/cleanup SQL drafts. It still does not authorize or run a real DB write.

## Apply Guards

A future apply command must require all of the following:

- `--apply`
- `--yes-i-am-using-personal-dev-db`
- `--source-key` or tightly scoped `--input`
- `--limit N`, with `N <= 3`
- `--pre-apply-report <path>`
- `--rehearsal-run-id <id>` or deterministic rehearsal label
- `PERSONAL_DEV_SUPABASE_CONFIRM=1`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The future apply path must fail closed when:

- production/main Supabase URL is detected.
- secrets would be printed.
- `.env` contents are requested or printed.
- the pre-apply report is missing.
- the pre-apply report has `db_write_executed=true`.
- the pre-apply report has `mode=local_only`.
- `db_check.executed` is not true.
- `missing_sources > 0` or `missing_source_targets > 0`.
- source health is unsafe.
- an item has `needs_quality_review`.
- an item has `blocked_by_missing_required_field`.
- an item has `body_quality_degraded` and an update-like operation.
- an item still has unknown DB status.
- deletion, missing, inactive, or deprecate operation is present.
- `blocked_write_plan_operations > 0` for the selected item.

## Apply Candidate Policy

The first rehearsal must prefer operations that preserve auditability and provenance without modifying canonical notice content.

Initial candidate operation types:

- `insert_run`
- `insert_source_result`
- `insert_occurrence`
- `insert_notice_target`
- `insert_error`
- `insert_keyword_match`, only if keyword evidence is already reviewable

For a real write rehearsal, child operations must be reviewed with their parent dependencies. A selected `insert_occurrence`, `insert_notice_target`, or `insert_error` alone is not a dependency-complete lifecycle rehearsal when `insert_run`, `insert_source_result`, or `insert_notice` were excluded.

Default blocked operation types:

- `insert_notice`, until body quality, read-only DB comparison, and source/duplicate gates pass; absent assets are risk evidence, not an automatic blocker by themselves.
- `update_notice_metadata`, until read-only DB comparison and user review pass.
- `update_notice_body`, blocked for the first rehearsal.
- `insert_asset`, until asset URL and metadata validation are reviewed.
- any delete, inactive, missing, or deprecate operation.

## Rehearsal Planner

Script:

```text
scripts/prepare-crawler-guarded-apply-rehearsal.mjs
```

The planner reads a pre-apply safety report and creates a stricter rehearsal plan. It never connects to DB and never writes.

Rejected options:

- `--apply`
- `--write`
- `--commit`

Required options:

- `--pre-apply-report <path>`
- `--max-items <N>`

Common command:

```bash
node scripts/prepare-crawler-guarded-apply-rehearsal.mjs \
  --pre-apply-report reports/pre-apply-safety-sample-source.readonly-db.verify.json \
  --source-key yonsei_060 \
  --max-items 1 \
  --allow-operation insert_run \
  --allow-operation insert_source_result \
  --allow-operation insert_occurrence \
  --allow-operation insert_notice_target \
  --allow-operation insert_error \
  --out reports/guarded-apply-rehearsal-plan.verify.json \
  --json
```

If the input report is still `local_only`, the planner returns `sample_apply_rehearsal_ready=false` and blocks selected operations with `read_only_db_check_required`.

The planner also reports `go_no_go.real_apply_ready=false` by design. A real apply remains a separate user-approved phase even when dry-run rehearsal candidates exist.

## Rollback And Cleanup Plan

Review-only draft:

```text
sql/drafts/crawler-guarded-sample-apply-cleanup.review.sql
```

Cleanup rules:

- Identify rows by `crawler_runs.id` or a deterministic `metadata.rehearsal_label`.
- Run SELECT previews before any delete.
- Keep `ROLLBACK` as the default transaction ending.
- Review FK delete order before execution.
- Never clean up rows that cannot be tied to the rehearsal run or label.
- Never run against production/main Supabase.

## Audit Trail Verification Plan

Read-only draft:

```text
sql/drafts/crawler-guarded-sample-apply-audit-checks.review.sql
```

The audit checks cover:

- `crawler_runs`
- `crawler_source_results`
- `crawler_notice_occurrences`
- `crawler_notice_targets`
- `crawler_notice_url_aliases`
- `crawler_notice_assets`
- `crawler_errors`
- `crawler_keyword_matches`
- orphan checks
- timestamp sanity checks

## Future Command Templates

1. Generate the personal-dev read-only DB comparison report:

```bash
PERSONAL_DEV_SUPABASE_CONFIRM=1 \
node scripts/plan-crawler-pre-apply-safety-dry-run.mjs \
  --input fixtures/crawler-ingest-dry-run/adapted-collector-output-sample-sources.json \
  --check-db \
  --yes-i-am-using-personal-dev-db \
  --out reports/pre-apply-safety-sample-source.readonly-db.verify.json \
  --json
```

2. Prepare the rehearsal plan:

```bash
node scripts/prepare-crawler-guarded-apply-rehearsal.mjs \
  --pre-apply-report reports/pre-apply-safety-sample-source.readonly-db.verify.json \
  --source-key yonsei_060 \
  --max-items 1 \
  --allow-operation insert_run \
  --allow-operation insert_source_result \
  --allow-operation insert_occurrence \
  --allow-operation insert_notice_target \
  --allow-operation insert_error \
  --out reports/guarded-apply-rehearsal-plan.verify.json \
  --json
```

3. Review the rehearsal plan:

```bash
node -e "const fs=require('fs'); const r=JSON.parse(fs.readFileSync('reports/guarded-apply-rehearsal-plan.verify.json','utf8')); console.log(r.summary, r.go_no_go)"
```

4. Future-only apply command placeholder:

```bash
# FUTURE ONLY - DO NOT RUN IN THIS STEP.
# node scripts/apply-crawler-controlled-sample-guarded.mjs --apply ...
```

5. Post-apply verification:

```bash
# Review and run only in personal dev after a separately approved sample apply.
# sql/drafts/crawler-guarded-sample-apply-audit-checks.review.sql
```

6. Cleanup/rollback review:

```bash
# Review only. Default transaction ends in ROLLBACK.
# sql/drafts/crawler-guarded-sample-apply-cleanup.review.sql
```

## Go / No-Go

GO for the next preparation review when:

- rehearsal planner reads the pre-apply report.
- blocked, review-required, unsafe, and quality-problem items are excluded.
- rollback SQL review draft exists.
- audit SQL review draft exists.
- reports can be generated without running apply.
- existing dry-run and regression commands still pass.

NO-GO for real apply when:

- source quality remains insufficient.
- notice insert/update would run for `needs_quality_review` items.
- rollback/audit plan is missing.
- production or secret leakage risk is present.
- deletion/inactive operation appears.
- user has not explicitly approved a separate sample apply step.

The older real sample source output remains NO-GO for real apply because `cau_001` has no input item, `cau_002` has short bodies, and no exact candidate set had passed read-only DB comparison. `no_assets` alone is no longer an automatic blocker under the updated Roadmap Phase 3 policy. The first future DB write rehearsal should still use the controlled fixture strategy in `docs/crawler-guarded-apply-readiness-review.md` unless a real source candidate passes all gates.

## Current Recommendation

Use this plan for user review first. If it passes review, prepare a separate, explicit, user-approved guarded sample apply command in a later step. Do not execute real sample apply in this phase.
