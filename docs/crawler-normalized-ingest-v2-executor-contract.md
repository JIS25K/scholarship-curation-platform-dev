# Crawler Normalized Ingest v2 Executor Contract

## Roadmap Position

- Current: Roadmap Phase 2
- Previous: Roadmap Phase 1 Controlled DB write rehearsal
- Next: Roadmap Phase 3 Real source mini apply

Roadmap Phase 2 converts the dry-run write plan into a normalized v2 upsert/merge executor. This contract is still local-only for Codex: Codex does not run DB writes, Supabase SQL, cleanup execution, real apply, full crawl, production/main Supabase, or batch apply.

## Scope

In scope:

- executor contract
- table-level write semantics
- idempotency and retry policy
- local-only plan and simulation reports
- guarded executor implementation
- schema conflict preflight before DB client creation
- failure and partial-write reporting
- report parity across plan/simulation/failure/apply shapes

Out of scope:

- Codex DB write
- Supabase SQL execution by Codex
- cleanup execution by Codex
- real source mini apply
- full crawl
- production/main Supabase
- batch apply

## Roadmap Phase 1 Lessons

Roadmap Phase 1 exposed a partial-write failure when `crawler_notice_url_aliases` was called with a conflict target that did not match the actual schema. Roadmap Phase 2 therefore requires:

- schema conflict preflight before any Supabase client is created,
- static validation against `sql/create-crawler-normalized-schema-v2.sql`,
- fail-closed behavior if a conflict target mismatch appears,
- failure report generation for any apply-path error,
- best-effort run status marking if a run exists before a child operation fails,
- dry-run, simulation, success, and failure report shape parity.

## Table Write Semantics

| Table | Operation | Identity / conflict target | Parent dependency | Idempotency rule | Retry behavior | Partial failure risk | Failure evidence | Cleanup / audit scope |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `crawler_runs` | insert | generated `id`; run scoped by `rehearsal_label` | none | New guarded attempt creates a new run. | Retry creates a new run, not a reused failed run. | Run may exist without child rows. | `run_id`, label, status, completed operations | `run_id`, `rehearsal_label` |
| `crawler_source_results` | insert | `(run_id, source_id)` | run, source | One result per run/source. | Retry under a new run writes a new result. | Source result may remain partial. | run/source, decision, failure code | `run_id`, `source_key` |
| `crawler_notices` | upsert | `canonical_key` | none | Canonical notice identity is stable. | Same key updates canonical fields. | Notice may exist before alias/occurrence rows. | canonical key, content hash | `canonical_key`, label |
| `crawler_notice_url_aliases` | upsert | `(notice_id, url_hash)` | notice, optional source | Same notice/url must not duplicate. | Upsert by actual schema target. | Conflict mismatch can stop apply after parent rows. | canonical key, URL fingerprint, conflict target | canonical key, source, label |
| `crawler_notice_occurrences` | upsert | `(source_id, discovered_url_hash)` | run, source, notice | Same source/discovered URL is one occurrence. | Upsert provenance fields. | Occurrence may point to a run before later rows finish. | source, canonical key, URL fingerprint | run, source, canonical key |
| `crawler_notice_targets` | upsert | `(notice_id, org_unit_id)` | notice, org unit | One target per notice/org unit. | Upsert confidence/evidence. | Missing org unit blocks target/apply candidate. | canonical key, org unit, source | canonical key, org unit, label |
| `crawler_notice_assets` | upsert | `(notice_id, asset_kind, source_url_hash)` | notice, optional occurrence | One asset per notice/kind/source URL. | Upsert referenced asset metadata. | Asset may be absent while notice exists. | canonical key, kind, URL fingerprint | canonical key, label |
| `crawler_keyword_matches` | append after recompute | no schema unique key | notice | Delete/recompute per notice/rule version before insert. | Recompute deterministic matches. | Duplicates if recompute is skipped. | canonical key, rule version, keyword | canonical key, rule version |
| `crawler_errors` | append | generated `id` | run, optional source/notice/occurrence | Append run-scoped audit evidence. | New run records new errors. | Error row may exist without successful completion. | run/source/canonical/stage/class | run, label |

## Operation Model

The executor emits normalized operations with:

- `operation`
- `table`
- `dependencies`
- `source_key`
- `canonical_key`
- `rehearsal_label`
- `would_write`
- `requires_review`
- `conflict_target`
- `idempotency_key`
- `failure_policy`

The planned order is:

1. `insert_run`
2. `insert_source_result`
3. `upsert_notice`
4. `upsert_url_alias`
5. `upsert_occurrence`
6. `upsert_notice_target`
7. `upsert_notice_asset`
8. `insert_keyword_match`
9. `insert_error`
10. `mark_run_failed_on_error`
11. `mark_run_succeeded_on_success`

## Guard Contract

Without `--apply`, the executor must never create a Supabase client.

With `--apply`, the executor must reject before client creation unless all are present:

- `--yes-i-am-using-personal-dev-db`
- `--i-understand-this-writes-to-personal-dev-db`
- `PERSONAL_DEV_SUPABASE_CONFIRM=1`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `--source-key`
- `--limit` between 1 and 3
- `--rehearsal-label`
- schema conflict preflight `ok=true`
- production/main Supabase indicator check passes

The executor must not print Supabase URL, service role key, `.env`, or raw payload body.

## Schema Conflict Preflight

The preflight parses:

```text
sql/create-crawler-normalized-schema-v2.sql
```

Expected matches:

- `crawler_notices`: `canonical_key`
- `crawler_notice_url_aliases`: `notice_id,url_hash`
- `crawler_notice_occurrences`: `source_id,discovered_url_hash`
- `crawler_notice_targets`: `notice_id,org_unit_id`
- `crawler_notice_assets`: `notice_id,asset_kind,source_url_hash`

Any mismatch is a Roadmap Phase 2 NO-GO and must be reported before apply guards can pass.

## Failure And Partial-Write Policy

Failure reports must include:

- `ok=false`
- safety flags
- failed operation and table
- error message
- `partial_write_possible`
- `partial_write_risk`
- `simulated_failure=true` and `expected_failure=true` for local failure simulation
- `cleanup_required`
- `run_status_update_attempted`
- completed operations
- pending operations
- guards
- source key, canonical key, and rehearsal label

If real apply is later run by the user and a child operation fails after the run exists, the executor attempts a best-effort `crawler_runs.status='failed'` update. That status update is audit support, not rollback.

## Report Parity

Every report shape must include:

- `db_write_executed`
- `supabase_sql_executed`
- `real_apply_executed`
- `go_no_go`
- `schema_conflict_preflight`
- `guards`
- `report_parity_checks`

Top-level safety flags must match nested `go_no_go` safety flags. Local plan and simulation reports keep all write flags false.

`--simulate-failure` is validation-friendly: if the simulator successfully generates the expected failure report, the process exits zero even though the report itself keeps `ok=false`. A nonzero exit means the simulator crashed or failed to generate the required report.

## Roadmap Phase 3 Entry Requirement

Roadmap Phase 3 Real source mini apply must not start merely because Roadmap Phase 2 local simulation passes. It also needs real source candidate selection and a read-only gate that confirms source quality, canonical identity, alias behavior, source target coverage, and no unsafe duplicate state.
