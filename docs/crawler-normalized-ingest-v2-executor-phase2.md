# Crawler Normalized Ingest v2 Executor Roadmap Phase 2

## Definition

Roadmap Phase 2 is the normalized ingest v2 executor phase. Its job is to turn dry-run write plans into a guarded v2 upsert/merge executor while keeping Codex local-only unless a future user-approved personal-dev apply is explicitly run outside this Codex task.

This work does not run DB writes, Supabase SQL, cleanup SQL, full crawl, production/main Supabase, real source mini apply, or batch apply.

## Roadmap Context

- Current: Roadmap Phase 2
- Previous: Roadmap Phase 1 Controlled DB write rehearsal
- Next: Roadmap Phase 3 Real source mini apply
- Later: Roadmap Phase 4 Full crawl dry-run

Roadmap Phase 1 proved that a controlled fixture could be written in personal dev and audited, but it also exposed a real partial-write failure from an alias conflict-target mismatch. Roadmap Phase 2 responds by making schema conflict preflight a required local gate before any apply path can create a Supabase client.

## Gates

Roadmap Phase 2 - Gate 1: executor contract

- Contract: `docs/crawler-normalized-ingest-v2-executor-contract.md`
- Defines table write semantics, idempotency, retry, partial failure, audit, and cleanup scope.

Roadmap Phase 2 - Gate 2: local simulation

- Script: `scripts/apply-normalized-ingest-v2-guarded.mjs`
- Modes: `--plan-only`, `--simulate-apply`, `--simulate-failure`, `--check-conflicts`
- All local reports keep `db_write_executed=false`, `supabase_sql_executed=false`, and `real_apply_executed=false`.

Roadmap Phase 2 - Gate 3: guarded executor implementation

- Future `--apply` path exists behind personal-dev guards.
- Codex did not execute `--apply`.
- Guard rejection happens before Supabase client creation if any required flag/env/schema check is missing.

Roadmap Phase 2 - Gate 4: validation/reporting/docs

- Package scripts expose local-only check/plan/simulation/failure commands.
- Existing Roadmap Phase 1 docs link forward to Roadmap Phase 2.
- Report parity checks ensure safety flags remain consistent.

## Table Write Semantics Summary

- `crawler_runs`: insert parent run; new run per guarded attempt.
- `crawler_source_results`: insert one row per run/source.
- `crawler_notices`: upsert by `canonical_key`.
- `crawler_notice_url_aliases`: upsert by `notice_id,url_hash`.
- `crawler_notice_occurrences`: upsert by `source_id,discovered_url_hash`.
- `crawler_notice_targets`: upsert by `notice_id,org_unit_id`.
- `crawler_notice_assets`: upsert by `notice_id,asset_kind,source_url_hash`.
- `crawler_keyword_matches`: append after deterministic recompute per notice/rule version.
- `crawler_errors`: append run-scoped warning/error evidence.

## Idempotency Policy

The executor uses deterministic `idempotency_key` values in local reports. For real apply, idempotency relies on schema conflict targets where available and explicit recompute policy where the schema has no unique key.

The known sensitive point is `crawler_notice_url_aliases`: Roadmap Phase 2 expects the executor target `notice_id,url_hash` to match the schema. If the schema parser cannot verify it, apply is NO-GO.

## Transaction And Partial Failure Policy

The future apply path writes parent rows first, then child rows. If a child operation fails after a run exists, the executor attempts a best-effort run status update to `failed`. This is audit evidence only; cleanup remains a separate user-reviewed action.

Failure simulation reports:

- failed operation/table,
- partial-write possibility,
- `partial_write_risk=true`,
- cleanup requirement,
- `simulated_failure=true` and `expected_failure=true`,
- completed and pending operations,
- run status update attempt expectation,
- source/canonical/rehearsal identifiers.

`--simulate-failure` exits zero when the simulator successfully generates the expected failure report. The report itself still keeps `ok=false` because it is modeling an ingest failure. A nonzero exit from this mode means the simulator failed, not merely that the simulated ingest failed.

## Guard Matrix

| Condition | Plan/simulation | Future apply |
| --- | --- | --- |
| Supabase client creation | never | only after all guards pass |
| `--yes-i-am-using-personal-dev-db` | not required | required |
| `--i-understand-this-writes-to-personal-dev-db` | not required | required |
| `PERSONAL_DEV_SUPABASE_CONFIRM=1` | not required | required |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | not required | required, never printed |
| production/main indicator check | reported | required |
| schema conflict preflight | required for review | required before client creation |
| source key / limit / label | defaults allowed for local review | explicit and bounded |

## Local Validation Commands

Use bundled Node if `npm` is unavailable:

```bash
node --check scripts/apply-normalized-ingest-v2-guarded.mjs
node --check scripts/apply-crawler-controlled-sample-guarded.mjs
node --check scripts/ingest-crawler-run-dry-run.mjs
node --check scripts/plan-crawler-pre-apply-safety-dry-run.mjs
```

Local-only package scripts:

```bash
npm run crawler:ingest:v2:check
npm run crawler:ingest:v2:plan -- --input fixtures/crawler-ingest-dry-run/guarded-apply-controlled-sample-input.json --source-key yonsei_060 --limit 1 --rehearsal-label roadmap-phase2-local-plan
npm run crawler:ingest:v2:simulate -- --input fixtures/crawler-ingest-dry-run/guarded-apply-controlled-sample-input.json --source-key yonsei_060 --limit 1 --rehearsal-label roadmap-phase2-local-sim
npm run crawler:ingest:v2:simulate-failure -- --input fixtures/crawler-ingest-dry-run/guarded-apply-controlled-sample-input.json --source-key yonsei_060 --limit 1 --rehearsal-label roadmap-phase2-local-failure
```

Equivalent direct commands:

```bash
node scripts/apply-normalized-ingest-v2-guarded.mjs --check-conflicts --json
node scripts/apply-normalized-ingest-v2-guarded.mjs --plan-only --json --input fixtures/crawler-ingest-dry-run/guarded-apply-controlled-sample-input.json --source-key yonsei_060 --limit 1 --rehearsal-label roadmap-phase2-local-plan
node scripts/apply-normalized-ingest-v2-guarded.mjs --simulate-apply --json --input fixtures/crawler-ingest-dry-run/guarded-apply-controlled-sample-input.json --source-key yonsei_060 --limit 1 --rehearsal-label roadmap-phase2-local-sim
node scripts/apply-normalized-ingest-v2-guarded.mjs --simulate-failure --json --input fixtures/crawler-ingest-dry-run/guarded-apply-controlled-sample-input.json --source-key yonsei_060 --limit 1 --rehearsal-label roadmap-phase2-local-failure
node scripts/apply-normalized-ingest-v2-guarded.mjs --apply --json
```

The final command must reject before DB client creation unless all personal-dev apply guards are present.

Expected exit codes:

- `--check-conflicts`, `--plan-only`, and `--simulate-apply`: zero when local validation succeeds.
- `--simulate-failure`: zero when the expected failure report is generated.
- `--apply --json` without guards: nonzero, with an apply guard rejection report and all write flags false.

## Go / No-Go

GO for Roadmap Phase 2 local review:

- contract exists,
- local simulation works,
- schema conflict preflight returns `mismatches=[]`,
- guard rejection report keeps all write flags false,
- report parity passes,
- no Supabase client is created in local-only modes.

NO-GO remains:

- Codex DB write,
- Supabase SQL execution by Codex,
- real source mini apply,
- full crawl,
- production/main Supabase,
- cleanup execution by Codex,
- batch apply.

## Recommended Next Step

Before Roadmap Phase 3, add a real source candidate selection/read-only gate. The candidate gate should choose 1 to 3 real source output items that pass body quality, canonical key, alias, source target, duplicate, and source health checks before any personal-dev mini apply is considered.
