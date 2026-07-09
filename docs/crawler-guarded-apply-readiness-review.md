# Crawler Guarded Apply Readiness Review

## Purpose

This document is a readiness review, not an apply runbook. It explains why the current real sample source output is still NO-GO for a real DB write rehearsal and defines a controlled fixture strategy for the first future personal-dev write rehearsal.

No real ingest apply, Supabase write, migration, cleanup SQL, crawler run, or deletion/inactive apply is approved by this document.

## Current Rehearsal Result

The guarded rehearsal planner is behaving as intended:

- `ok=true`
- `db_write_executed=false`
- `supabase_sql_executed=false`
- `real_apply_executed=false`
- `sample_apply_rehearsal_ready=true`
- `selected_items=1`
- `selected_operations=3`
- selected operations: `insert_occurrence`, `insert_notice_target`, `insert_error`
- excluded operations: `insert_run`, `insert_source_result`, `insert_notice`, `skip_update_due_to_low_quality`, `insert_keyword_match`

This means the dry-run planner found operations worth reviewing. It does not mean real apply is GO. Real DB write still requires a separate user-approved command, dependency review, rollback/audit review, and either a controlled fixture or source output that passes the quality gate.

## Source Assessment

`cau_001` is not a sample apply candidate because the adapted sample has no input items. It cannot exercise notice insert, occurrence, target, asset, or error persistence.

`cau_002` has real source-like sample items, but the current bodies are short and assets are missing. Those items are useful for quality-gate diagnostics, not for the first notice lifecycle write rehearsal.

`yonsei_060` has a usable detail body, but it still has `no_assets`. The planner can select provenance/error-style operations, but automatic notice insert remains blocked by quality review.

Across the current real sample output, no item cleanly passes the automatic notice insert criteria. A real write using only occurrence/target/error operations would not prove the full notice lifecycle and may run into parent-row or FK assumptions.

## Operation Dependency Assessment

`crawler_runs` is the parent provenance record for a crawler execution. A real rehearsal should preserve a run-level identifier so later audit and cleanup can be scoped.

`crawler_source_results` preserves per-source execution summary and should be tied to the run and source.

`crawler_notices` is the stable parent for occurrence, target, URL alias, asset, and keyword-match records.

`crawler_notice_occurrences` records source/run/discovered URL provenance and should not be treated as a complete rehearsal if its parent notice or run assumptions are unresolved.

`crawler_notice_targets` records the source-to-org-unit targeting result and depends on a stable notice identity.

`crawler_errors` preserves warning/error evidence and should be associated with the relevant run/source/item context.

The recommended minimal dependency-complete operation set for a first future write rehearsal is:

- `insert_run`
- `insert_source_result`
- `insert_notice`
- `insert_occurrence`
- `insert_notice_target`
- `insert_error`

`insert_asset` can be added when asset URL and metadata policy are explicitly reviewed. `insert_keyword_match` can be added after keyword evidence storage is confirmed.

## Strategy Comparison

Strategy A is a real source output minimum sample. It is closer to real collection behavior, but the current sample does not produce a quality-clean notice insert candidate. It is better after adapter quality improves.

Strategy B is a controlled fixture minimum sample. It is less representative of adapter quality, but it is better for validating FK dependencies, unique-key behavior, rollback scoping, audit trail checks, and fail-closed apply guards.

Recommendation: use Strategy B for the first future personal-dev DB write rehearsal, then expand to Strategy A after a real source item passes body/assets quality review.

## Controlled Fixture

Fixture:

```text
fixtures/crawler-ingest-dry-run/guarded-apply-controlled-sample-input.json
```

Policy:

- use a real known source key, currently `yonsei_060`.
- include one item only.
- include a title and URL with an explicit controlled rehearsal marker.
- include no missing required fields.
- include enough body text to avoid `short_body`.
- include one synthetic attachment asset so the asset path can be planned.
- include `controlled_apply_rehearsal_fixture` in warnings/metadata so it cannot be mistaken for real crawler output.
- use the fixture only for dry-run planning in this phase.

The controlled fixture verifies planner behavior and dependency planning. It does not validate that the real source adapter is production-quality.

## Go / No-Go

GO for the next review phase:

- review this readiness document.
- review the controlled fixture strategy.
- generate local dry-run reports for the controlled fixture.
- optionally generate a personal-dev read-only DB comparison for the controlled fixture, without writes.

NO-GO for real apply:

- the user has not explicitly approved a separate real apply prompt.
- current real source output still lacks a clean notice insert candidate.
- selected child operations may need parent run/source_result/notice rows.
- rollback and audit SQL drafts have not been exercised after a real write.
- production/main Supabase remains prohibited.

## Recommended Next Step

Prepare a separate explicit user-approved guarded controlled sample apply prompt. That later prompt should include a dependency-complete operation set, personal-dev-only gates, a deterministic rehearsal label, audit checks, and rollback/cleanup review. It should still fail closed unless the selected fixture report has read-only DB comparison evidence and the user explicitly approves the write.
