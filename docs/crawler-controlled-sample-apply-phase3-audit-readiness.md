# Crawler Controlled Sample Apply Phase 3 Audit Readiness

## Purpose

Phase 3 records the successful controlled sample retry, fixes a reporting inconsistency, and defines the next readiness gate before moving from a controlled fixture to real collector output.

Codex did not run real apply, did not execute SQL, did not access Supabase, and did not run cleanup in this phase.

## Phase 2 Retry Status

The user confirmed that the Phase 2 controlled sample real apply retry succeeded in a personal dev Supabase database.

Report:

```text
reports/controlled-sample-apply.phase2-retry.executed.json
```

Key values reported by the user:

- `mode=apply`
- `ok=true`
- `db_write_executed=true`
- `supabase_sql_executed=true`
- `real_apply_executed=true`
- `source_key=yonsei_060`
- `rehearsal_label=controlled-sample-phase2-retry-20260709`
- `apply_result.run_id=f14548e7-7bc2-4244-94b5-69b431aa67f7`
- `apply_result.notice_id=3`
- `apply_result.occurrence_id=2`

The first Phase 2 attempt failed before URL alias insertion. The user already verified and cleaned up that partial write. Codex did not execute cleanup.

## Audit Row Count

The user confirmed that read-only audit row counts matched the expected controlled lifecycle shape exactly:

| Table | Expected |
| --- | ---: |
| `crawler_runs` | 1 |
| `crawler_source_results` | 1 |
| `crawler_notices` | 1 |
| `crawler_notice_url_aliases` | 1 |
| `crawler_notice_occurrences` | 1 |
| `crawler_notice_targets` | 1 |
| `crawler_notice_assets` | 1 |
| `crawler_errors` | 1 |
| `crawler_keyword_matches` | 1 |

This confirms that the controlled fixture exercised the full intended run/source/notice/alias/occurrence/target/asset/error/keyword lifecycle for one item.

## Phase 3 Code Fix

The successful retry report had a small inconsistency:

- top-level `real_apply_executed=true`
- nested `go_no_go.real_apply_executed=false`

The executor now updates the success report through a shared success-marking path so apply success reports set:

```json
{
  "real_apply_executed": true,
  "go_no_go": {
    "real_apply_ready": true,
    "real_apply_executed": true,
    "reason": "controlled_personal_dev_apply_executed"
  }
}
```

Plan-only and failure paths still keep real apply execution false unless they are explicitly local-only success simulations.

## Local-Only Regression

The executor now supports a DB-free success report simulation:

```bash
node scripts/apply-crawler-controlled-sample-guarded.mjs \
  --simulate-apply-success-report \
  --json
```

This creates no Supabase client and performs no DB write. It validates that the top-level and nested `real_apply_executed` fields align in the success-report shape.

Existing local-only preflight remains:

```bash
node scripts/apply-crawler-controlled-sample-guarded.mjs \
  --check-conflicts \
  --json
```

## Audit SQL

Read-only audit draft:

```text
sql/drafts/crawler-guarded-sample-apply-audit-checks.review.sql
```

The draft includes Phase 2 retry placeholders for the confirmed run id, rehearsal label, expected source key, expected org unit, and expected row counts. It remains review-only SELECT SQL.

## Cleanup Review

Cleanup draft:

```text
sql/drafts/crawler-guarded-sample-apply-cleanup.review.sql
```

Cleanup remains NO-GO unless the user explicitly requests it. The draft keeps `ROLLBACK` as the default and documents FK-aware delete order for a successful apply cleanup.

## Next Step Candidates

1. Review controlled fixture cleanup, but execute cleanup only after explicit user approval.
2. Promote one real collector output item to a controlled apply candidate through dry-run and read-only gates.
3. Re-evaluate `cau_001`, `cau_002`, and `yonsei_060` to find one real item with sufficient body and asset evidence for a later rehearsal.

## Go / No-Go Checklist

GO for the next design review:

- Phase 2 retry success report reviewed.
- Audit row counts match the expected lifecycle shape.
- Success reporting simulation passes locally.
- Schema conflict preflight remains clean.
- Cleanup remains review-only.

NO-GO remains:

- full crawl
- real crawler-output ingest
- production/main Supabase
- cleanup execution unless explicitly approved
- any real apply retry by Codex

