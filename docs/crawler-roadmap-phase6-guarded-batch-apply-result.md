# Crawler Roadmap Phase 6 Guarded Batch Apply Result

## Status

Roadmap Phase 6 result: PASS.

Phase 6 applied only the 84 clean candidates from the Phase 5 candidate plan to personal-dev DB. It did not apply the full 179 Phase 4 matched items, did not apply review-only/excluded/duplicate-review/unsafe/blocked items, and did not modify the Phase 5 candidate plan to increase the candidate count.

## Input And Scope

| Item | Value |
| --- | --- |
| input candidate plan | `fixtures/crawler-ingest-dry-run/roadmap-phase5-phase6-candidate-plan.json` |
| apply input fixture | `fixtures/crawler-ingest-dry-run/roadmap-phase6-clean84-apply-input.json` |
| rehearsal_label | `roadmap-phase6-guarded-batch-apply-20260710-clean84` |
| candidate count requested | 84 |
| distinct source_key count | 84 |
| no_assets among selected/applied | 48 |
| excluded/review/duplicate/unsafe/blocked selected | 0 |
| missing_source / missing_source_target / missing_org_unit | 0 / 0 / 0 |

## Apply Summary

| Metric | Value |
| --- | ---: |
| candidate count requested | 84 |
| candidate count applied | 84 |
| candidate count skipped | 0 |
| candidate count failed | 0 |
| distinct source_key count applied | 84 |
| no_assets among applied | 48 |
| run_id count | 84 |

Run identifier scope:

```text
rehearsal_label=roadmap-phase6-guarded-batch-apply-20260710-clean84
first_run_id=b143088e-cc90-4e66-a4d9-4d248f86c9dc
last_run_id=5aeba907-f49d-4bdc-a647-cbddaa826e15
run_id_count=84
```

## Row Counts By Table

| Table | Rows |
| --- | ---: |
| `crawler_runs` | 84 |
| `crawler_source_results` | 84 |
| `crawler_notices` | 84 |
| `crawler_notice_url_aliases` | 84 |
| `crawler_notice_occurrences` | 84 |
| `crawler_notice_targets` | 84 |
| `crawler_notice_assets` | 96 |
| `crawler_errors` | 0 |
| `crawler_keyword_matches` | 141 |

## Created Vs Updated Counts

The existing executor uses upsert and does not return insert-vs-update action per row.

| Metric | Value |
| --- | ---: |
| executor returned created/updated split | not available |
| inferred new notice candidates before apply | 84 |
| inferred changed candidates before apply | 0 |
| inferred unchanged candidates before apply | 0 |
| final canonical notice rows found | 84 |

Interpretation: created-vs-updated is not directly available from the executor result. Based on the read-only preflight, the 84 applied notices were classified as new candidates before apply.

## Post-Apply Sanity Check

| Check | Result |
| --- | --- |
| sanity check overall | PASS |
| run statuses | succeeded:84 |
| source result decisions | succeeded:84 |
| duplicate check | PASS |
| orphan check | PASS |

Duplicate check details:

| Check | Count |
| --- | ---: |
| duplicate notices | 0 |
| duplicate URL aliases | 0 |
| duplicate occurrences | 0 |
| duplicate targets | 0 |
| duplicate assets | 0 |

Orphan check details:

| Check | Count |
| --- | ---: |
| orphan occurrences | 0 |
| orphan targets | 0 |
| orphan aliases | 0 |
| orphan assets | 0 |

## Partial Write Risk

Risk: low.

All 84 source-scoped guarded apply runs succeeded. Every applied candidate is traceable by `rehearsal_label`, `run_id`, `canonical_key`, and `source_key`. No failed scope was reported by the apply wrapper, and post-apply duplicate/orphan checks passed.

Cleanup/rollback identifiers:

```text
rehearsal_label=roadmap-phase6-guarded-batch-apply-20260710-clean84
run_ids=fixtures/crawler-ingest-dry-run/roadmap-phase6-guarded-batch-apply-result.json#run_ids
canonical_keys=fixtures/crawler-ingest-dry-run/roadmap-phase6-guarded-batch-apply-result.json#cleanup_rollback_identifiers.canonical_keys
source_keys=fixtures/crawler-ingest-dry-run/roadmap-phase6-guarded-batch-apply-result.json#cleanup_rollback_identifiers.source_keys
```

No cleanup SQL was generated or executed.

## Applied Scope Sample

| Source key | Canonical key | No assets |
| --- | --- | --- |
| `cau_010` | `cau_010:url:04d1476e9e9013172740` | no |
| `cau_065` | `cau_065:url:bd38a512f055feb1c602` | yes |
| `cau_066` | `cau_066:url:0833e4584c2a6c0cf739` | yes |
| `cau_068` | `cau_068:url:d38d8fd2d3bb8ed7e792` | yes |
| `cau_076` | `cau_076:url:b6fec21a48017bec7147` | no |
| `cau_079` | `cau_079:url:60282bbe3d7c37f78955` | no |
| `cau_080` | `cau_080:url:d576e8c0c5325c2e1166` | yes |
| `cau_081` | `cau_081:url:0d7988f28ce2c30a037c` | yes |
| `ewha_004` | `ewha_004:url:94582130e91c46ed6524` | no |
| `ewha_008` | `ewha_008:url:c69b0be64d85f5fd49ff` | yes |
| `ewha_012` | `ewha_012:url:40f13ff3947016c3d001` | no |
| `ewha_013` | `ewha_013:url:2e0e438ec38ce5f4d64b` | yes |

Full machine-readable result:

```text
fixtures/crawler-ingest-dry-run/roadmap-phase6-guarded-batch-apply-result.json
```

## Safety Confirmation

| Check | Result |
| --- | --- |
| DB write executed | true |
| raw/arbitrary Supabase SQL executed | false |
| cleanup SQL generated | false |
| cleanup SQL executed | false |
| production/main Supabase accessed | false |
| full 179 item apply executed | false |
| review/excluded/duplicate/unsafe/blocked apply executed | false |

Note: the guarded executor writes via Supabase client APIs. No raw/arbitrary SQL was executed.

## Phase 7 Readiness

Roadmap Phase 7 can begin next: yes.

Carry-forward risks:

- CRAWL_MAX_ITEMS_PER_SOURCE=1 shallow observation remains a coverage risk.
- 434 zero-match sources remain unresolved observation-performance risk.
- National coverage completeness is not proven by Phase 6.
- Duplicate/review and quality-review backlog remains outside this clean84 apply.
- no_assets quality risk remains for 48 applied candidates.
