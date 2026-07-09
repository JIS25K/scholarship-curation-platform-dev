# Crawler Roadmap Phase 1 - Gate 4 Controlled Sample Cleanup Readiness

## Purpose

Roadmap Phase 1 - Gate 4 prepares the controlled fixture cleanup gate before moving toward any real crawler-output ingest.

This phase does not delete the controlled fixture, does not execute SQL, does not access Supabase, and does not approve a real DB write. It only documents the manual audit -> cleanup review -> post-cleanup verification path for the user to run in a confirmed personal dev database.

## Current Verified State

Roadmap Phase 1 - Gate 2 controlled sample apply retry: PASS.

The user confirmed the personal dev audit row counts matched the expected controlled lifecycle shape exactly:

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

Roadmap Phase 1 - Gate 3 audit readiness/reporting alignment: PASS.

The Roadmap Phase 1 - Gate 3 success simulation confirmed that local success reporting now aligns top-level and nested `go_no_go.real_apply_executed` values while still leaving local simulation as `db_write_executed=false` and `supabase_sql_executed=false`.

## Controlled Fixture Identifiers

The cleanup and audit gate is scoped to these exact identifiers:

| Field | Value |
| --- | --- |
| `source_key` | `yonsei_060` |
| `canonical_key` | `yonsei_060:url:e74c29f4562cf52025d9` |
| `rehearsal_label` | `controlled-sample-phase2-retry-20260709` |
| `run_id` | `f14548e7-7bc2-4244-94b5-69b431aa67f7` |
| `notice_id` | `3` |
| `occurrence_id` | `2` |
| `expected_org_unit_id` | `46` |

Cleanup must not be scoped by `source_key` alone. `source_key=yonsei_060` is only one part of the fixture identity. The `controlled-sample-phase2-retry-20260709` label is a legacy audit identifier and is intentionally preserved.

## Why Cleanup Readiness Comes Before Real Output

The controlled fixture proved that the apply path can create the full lifecycle row set in personal dev. Before introducing real collector output, the team needs a reviewed way to:

- prove exactly which rows belong to the controlled fixture,
- remove those rows without touching unrelated source data,
- verify the cleanup left no fixture residue,
- keep a clear audit trail for what Codex did and did not execute.

This is a small gate, but it keeps later real-output testing from mixing fixture rows with real crawler data.

## Audit Query Sequence

Use the read-only audit draft:

```text
sql/drafts/crawler-guarded-sample-apply-audit-checks.review.sql
```

The audit SQL is SELECT-only and uses the exact Roadmap Phase 1 - Gate 2 retry identifiers. It checks:

- fixture identifier values,
- row counts for the nine expected lifecycle tables,
- run metadata,
- source result linkage,
- occurrence and notice linkage,
- expected org unit target linkage,
- alias, asset, error, and keyword evidence linked back to the controlled notice/run,
- orphan sanity checks,
- timestamp sanity.

Expected result before cleanup: every row-count summary entry is `actual_count=1` and the scoped orphan checks return zero.

## Cleanup Review Sequence

Use the cleanup review draft:

```text
sql/drafts/crawler-guarded-sample-apply-cleanup.review.sql
```

The cleanup SQL is intentionally review-only by default:

- it starts a transaction,
- it prints pre-cleanup scoped counts,
- it deletes in FK-safe order,
- it prints post-cleanup scoped counts,
- it ends with `ROLLBACK`.

The FK-safe delete order is:

1. `crawler_keyword_matches`
2. `crawler_errors`
3. `crawler_notice_assets`
4. `crawler_notice_targets`
5. `crawler_notice_url_aliases`
6. `crawler_notice_occurrences`
7. `crawler_source_results`
8. `crawler_notices`
9. `crawler_runs`

The user must keep `ROLLBACK` during review. The user may change `ROLLBACK` to `COMMIT` only after manual approval and only in a confirmed personal dev DB.

## Post-Cleanup Verification

After an approved user-run cleanup commit, rerun the post-cleanup count section from:

```text
sql/drafts/crawler-guarded-sample-apply-cleanup.review.sql
```

Expected result after committed cleanup: every scoped `after:*` count is zero.

If any scoped count is nonzero, real crawler-output ingest remains NO-GO. The remaining row must be inspected before any next phase.

## User Execution Instructions

Local guide command:

```bash
npm run crawler:apply:controlled-sample:cleanup-guide
```

If `npm` is unavailable in the local runtime, run the script directly:

```bash
node scripts/print-controlled-sample-cleanup-guide.mjs
```

Recommended manual sequence:

1. Review this Roadmap Phase 1 - Gate 4 document.
2. Review `sql/drafts/crawler-guarded-sample-apply-audit-checks.review.sql`.
3. In personal dev only, run the audit SQL and confirm the expected row counts.
4. Review `sql/drafts/crawler-guarded-sample-apply-cleanup.review.sql` with the default `ROLLBACK`.
5. In personal dev only, run the cleanup SQL with `ROLLBACK` and confirm the transaction-local post-cleanup counts would be zero.
6. If cleanup is approved, change only the final `ROLLBACK` to `COMMIT` and run manually.
7. Rerun the post-cleanup verification query and confirm all scoped counts are zero.
8. Share the post-cleanup row counts before any Roadmap Phase 3 work.

## Codex Prohibition

Codex must not:

- run cleanup SQL,
- change `ROLLBACK` to `COMMIT`,
- execute any live Supabase action,
- print `.env`, Supabase URL, service role key, or secrets,
- run full crawl,
- run real crawler-output ingest,
- run real apply.

## Go / No-Go

GO for user review:

- Roadmap Phase 1 - Gate 2 retry PASS is recorded.
- User audit row count matched expected is recorded.
- Roadmap Phase 1 - Gate 3 reporting alignment PASS is recorded.
- Audit SQL is read-only and exact-scope.
- Cleanup SQL is exact-scope, FK-order safe, and default `ROLLBACK`.
- Local cleanup guide prints identifiers and paths only.

NO-GO remains:

- full crawl,
- real crawler-output ingest,
- production/main Supabase,
- cleanup execution by Codex,
- live DB action by Codex,
- any apply or cleanup not scoped to the exact controlled fixture.

## Recommended Next Step

The user should review Roadmap Phase 1 - Gate 4 cleanup readiness. If approved, the user may execute personal-dev cleanup manually, then share post-cleanup row counts. After cleanup PASS, proceed to Roadmap Phase 2: Normalized ingest v2 executor.

## Roadmap Naming Note

This document was originally written during what is now named `Roadmap Phase 1 - Gate 4`. Older references to "Phase 4" in this history refer to Roadmap Phase 1 - Gate 4 controlled fixture cleanup readiness, not `Roadmap Phase 4 Full crawl dry-run`.

The normalized ingest v2 executor work is documented in:

```text
docs/crawler-normalized-ingest-v2-executor-contract.md
docs/crawler-roadmap-phase2-normalized-ingest-v2-executor.md
```
