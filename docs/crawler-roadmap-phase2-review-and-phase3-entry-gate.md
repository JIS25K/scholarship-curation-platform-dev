# Crawler Roadmap Phase 2 Review And Roadmap Phase 3 Entry Gate

## Purpose

This document reviews the Roadmap Phase 2 normalized ingest v2 executor result and defines the read-only entry gate required before Roadmap Phase 3 Real source mini apply can begin.

This document does not start Roadmap Phase 3. It does not authorize DB writes, Supabase SQL, cleanup SQL, real source mini apply, full crawl, production/main Supabase access, batch apply, source-target writes, org-unit backfill, or notice ingest.

## Roadmap Position

- Reviewed phase: Roadmap Phase 2 Normalized ingest v2 executor
- Next possible phase: Roadmap Phase 3 Real source mini apply
- Later phase: Roadmap Phase 4 Full crawl dry-run

Roadmap Phase 3 remains blocked until the entry gate in this document has a PASS result on 1 to 3 real source output items.

## Review Inputs

- `docs/crawler-normalized-ingest-v2-executor-contract.md`
- `docs/crawler-roadmap-phase2-normalized-ingest-v2-executor.md`
- `docs/crawler-sample-source-output-dry-run.md`
- `docs/crawler-pre-apply-safety-dry-run.md`
- `docs/crawler-guarded-apply-rehearsal-plan.md`
- `docs/crawler-guarded-apply-readiness-review.md`
- `scripts/apply-normalized-ingest-v2-guarded.mjs`
- `scripts/plan-crawler-pre-apply-safety-dry-run.mjs`
- `fixtures/crawler-ingest-dry-run/adapted-collector-output-sample-sources.json`

## Roadmap Phase 2 Result

Roadmap Phase 2 result: CONDITIONAL PASS.

PASS for Roadmap Phase 2 local-only closure:

- executor contract exists and documents table write semantics, idempotency, failure reporting, partial-write risk, and report parity.
- schema conflict preflight is part of the executor and is required before any future apply path can create a Supabase client.
- local plan, simulation, failure simulation, and unguarded apply rejection paths are available.
- local reports keep `db_write_executed=false`, `supabase_sql_executed=false`, and `real_apply_executed=false`.
- `--simulate-failure` intentionally exits zero only when the expected failure report is generated, while the report itself remains `ok=false`.
- unguarded `--apply --json` is expected to reject before DB client creation.

Conditions that prevent an unconditional PASS into Roadmap Phase 3:

- Roadmap Phase 2 validates executor safety, not real source quality.
- current real sample source output does not contain a clean automatic notice insert candidate.
- local-only mode cannot prove existing DB duplicate, alias, unchanged, or changed state.
- current sample source output still includes short body, no-asset, and zero-item cases.
- personal-dev read-only DB comparison is required for the exact Roadmap Phase 3 candidate set before any mini apply can be considered.

HOLD criteria:

- HOLD if schema conflict preflight reports any mismatch.
- HOLD if any local-only report sets DB, SQL, or real-apply safety flags to true.
- HOLD if unguarded apply creates or can create a Supabase client before guard rejection.
- HOLD if Roadmap Phase 3 candidates are selected from synthetic or controlled-fixture data instead of real source output.
- HOLD if a candidate still has unresolved source health, body quality, canonical identity, alias, source target, duplicate, or DB comparison uncertainty.

## Current Real Source Output Assessment

The current committed sample source fixture is useful for diagnostics, but it is not enough to enter Roadmap Phase 3.

| Source | Current evidence | Roadmap Phase 3 candidate status |
| --- | --- | --- |
| `cau_001` | no matched sample items | HOLD |
| `cau_002` | three matched items, short bodies, no assets | HOLD |
| `yonsei_060` | one item with detail body, no assets | HOLD until candidate policy accepts no-asset real items and DB read-only comparison passes |

Current source output should continue to be used for read-only diagnostics and gate design. It should not be used for real source mini apply yet.

## Roadmap Phase 3 Entry Gate

Roadmap Phase 3 may begin only after a read-only candidate gate selects 1 to 3 real source output items and records a PASS result for every required check below.

Required candidate evidence:

- source output comes from a public, official source and preserves the official URL.
- source does not require login, CAPTCHA bypass, access-control bypass, or robots.txt avoidance.
- source health is not blocked, degraded, network-failed, selector-mismatch, pagination-incomplete, or unsafe for lifecycle judgment.
- item has a meaningful title, discovered URL, canonical URL, publication date when available, and non-empty body text.
- body quality is sufficient for a notice insert or explicitly classified as review-only if assets are absent.
- canonical key is deterministic and does not collide within the candidate set.
- discovered URL and canonical URL alias behavior is explainable without collapsing shared-board evidence.
- source target coverage is present for the selected source and org unit.
- duplicate state is known through read-only comparison, not inferred from local-only mode.
- existing notice, alias, occurrence, and asset state are known through read-only comparison for the exact candidate set.
- write plan contains no delete, inactive, missing, deprecate, broad update, or lifecycle judgment operation.

Required report evidence:

- local candidate report has `db_write_executed=false`.
- local candidate report has `supabase_sql_executed=false`.
- local candidate report has `real_apply_executed=false`.
- personal-dev read-only DB comparison has `db_check.executed=true`.
- selected candidates have no `unknown_without_db_check`.
- selected candidates have no `blocked_by_missing_required_field`.
- selected candidates have no unsafe source-health blockers.
- selected candidates have no duplicate-within-input blocker.
- selected candidates have no unresolved source-target blocker.
- selected candidates have no blocked write-plan operation.

## Candidate Selection Procedure

1. Pick a new limited real source output fixture or report containing 1 to 3 items from public official sources.
2. Run the adapter into an ingest dry-run fixture without DB access.
3. Run the pre-apply safety dry-run locally and confirm it remains read-only.
4. In a personal-dev shell only, run the read-only DB comparison for the exact fixture and selected source keys.
5. Review body quality, canonical identity, alias behavior, source target coverage, duplicate state, and source health.
6. Record PASS, CONDITIONAL PASS, or HOLD for each candidate.
7. Start Roadmap Phase 3 only if at least one real source output candidate receives PASS and no candidate selected for the mini apply remains CONDITIONAL PASS or HOLD.

## Acceptable Commands For The Gate

Local-only pre-apply report:

```bash
node scripts/plan-crawler-pre-apply-safety-dry-run.mjs \
  --input <real-source-output-adapted-fixture.json> \
  --out reports/<roadmap-phase3-candidate>.local.verify.json \
  --json
```

Personal-dev read-only comparison, user shell only:

```bash
PERSONAL_DEV_SUPABASE_CONFIRM=1 \
node scripts/plan-crawler-pre-apply-safety-dry-run.mjs \
  --input <real-source-output-adapted-fixture.json> \
  --check-db \
  --yes-i-am-using-personal-dev-db \
  --out reports/<roadmap-phase3-candidate>.readonly-db.verify.json \
  --json
```

These commands are review gates. They are not Roadmap Phase 3 mini apply commands.

## Roadmap Phase 3 Non-Goals

Roadmap Phase 3 entry-gate work must not:

- write to Supabase.
- execute Supabase SQL.
- run cleanup SQL.
- run a full crawl.
- write or update `crawler_source_targets`.
- seed or backfill `org_units`.
- ingest notices.
- print `.env` contents or Supabase secrets.
- use production/main Supabase.
- treat shared `list_url` overlap as automatic duplicate collapse.

## Next Step

Prepare a Roadmap Phase 3 candidate-selection read-only report from a fresh limited real source output set. The first report should prefer 1 to 3 items from sources that already have evidence of clean detail body extraction and stable source health. If no current real source output item passes the gate, Roadmap Phase 3 remains HOLD and the next task should improve source output quality rather than attempting a mini apply.
