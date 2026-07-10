# Crawler Roadmap Phase 4-5 Funnel Accountability Report

## Executive Summary

Recommendation: **CONDITIONAL PROCEED TO PHASE 6**.

The 613 -> 179 -> 84 funnel is explainable and is useful for guarded batch ingest validation, but it must not be interpreted as national coverage completeness. The 84 Phase 6 candidates are clean candidates from the Phase 5 plan, source/target/org-unit readiness is known, and they are spread across 84 distinct source keys. That makes the set meaningful for testing the guarded ingest path.

The main caveat is observation performance. Phase 4 used `CRAWL_MAX_ITEMS_PER_SOURCE=1`, so it observed at most one list item per source. The 179 matched items are therefore an observed dry-run output, not a random sample and not automatically a safe subset of everything available across all source pagination depths.

No Phase 6 batch apply was run for this report. No DB write, raw/arbitrary Supabase SQL, cleanup SQL, or production/main Supabase access occurred.

## Meaning Of 613, 179, And 84

| Number | Meaning | Source |
| ---: | --- | --- |
| 613 | Canonical source rows covered by the Phase 4 full crawl dry-run. This corresponds to the source registry used by the crawler command and `perSource` result count. | Phase 4 output/report |
| 179 | Scholarship-matched notice items observed by Phase 4. These are local dry-run collector outputs, with one matched item from each of 179 source keys. | Phase 4 `newNotices` |
| 84 | Clean Phase 6 candidate notices selected by Phase 5 after DB/readiness checks and conservative exclusion of duplicate/provenance and quality-review items. | Phase 5 candidate plan |

The 179 items are an **observed output**, not a random sample and not automatically a safe subset. The 84 items are a **planner-selected clean candidate set** for ingest-path validation, not a completeness claim.

## Source-Level Funnel

| Metric | Count |
| --- | ---: |
| canonical source count | 613 |
| sources covered by Phase 4 | 613 |
| sources crawled at least one item | 606 |
| sources with explicit failures | 2 |
| HTTP error sources | 1 |
| timeout/abort sources | 1 |
| zero-crawled sources | 7 |
| zero-crawled without explicit error | 5 |
| sources with at least one matched notice item | 179 |
| sources with zero matched notice items | 434 |
| sources contributing Phase 6 clean candidates | 84 |
| sources with matched items but no Phase 6 candidates | 95 |
| crawled sources with no matched item | 427 |

The 434 zero-matched sources break down into 2 explicit failures, 5 zero-crawled/no-error sources, and 427 sources that crawled at least one list item but did not produce a scholarship match.

## Item-Level Funnel

| Metric | Count |
| --- | ---: |
| total matched items | 179 |
| clean Phase 6 candidates | 84 |
| duplicate/review candidates | 82 |
| quality-review candidates | 13 |
| excluded/review-only candidates | 95 |
| no_assets total | 103 |
| no_assets among Phase 6 candidates | 48 |
| blocked_by_schema | 0 |
| blocked_by_quality operations | 26 |
| missing_source | 0 |
| missing_source_target | 0 |
| missing_org_unit | 0 |
| new candidates before strict clean filter | 90 |
| unchanged candidates | 0 |
| changed candidates | 0 |

`no_assets` alone was not treated as an automatic blocker. It remains a product-quality risk, not an ingest-path blocker under the current policy.

## Source Concentration Analysis

At the source-key level, concentration is not extreme: Phase 4 capped output at one crawled item per source, and the 179 matched items came from 179 distinct source keys. The 84 clean candidates also came from 84 distinct source keys.

| Concentration metric | Count | Share |
| --- | ---: | ---: |
| matched items from top 5 source_keys | 5 | 2.8% |
| matched items from top 10 source_keys | 10 | 5.6% |
| Phase 6 candidates from top 5 source_keys | 5 | 6.0% |
| Phase 6 candidates from top 10 source_keys | 10 | 11.9% |

Top 10 source_keys by matched item count:

| Source key | Count | Share |
| --- | ---: | ---: |
| `cau_002` | 1 | 0.6% |
| `cau_010` | 1 | 0.6% |
| `cau_020` | 1 | 0.6% |
| `cau_026` | 1 | 0.6% |
| `cau_041` | 1 | 0.6% |
| `cau_042` | 1 | 0.6% |
| `cau_043` | 1 | 0.6% |
| `cau_044` | 1 | 0.6% |
| `cau_045` | 1 | 0.6% |
| `cau_046` | 1 | 0.6% |

Top 10 source_keys by Phase 6 candidate count:

| Source key | Count | Share |
| --- | ---: | ---: |
| `cau_010` | 1 | 1.2% |
| `cau_065` | 1 | 1.2% |
| `cau_066` | 1 | 1.2% |
| `cau_068` | 1 | 1.2% |
| `cau_076` | 1 | 1.2% |
| `cau_079` | 1 | 1.2% |
| `cau_080` | 1 | 1.2% |
| `cau_081` | 1 | 1.2% |
| `ewha_004` | 1 | 1.2% |
| `ewha_008` | 1 | 1.2% |

Matched items by university prefix:

| Prefix | Count | Share |
| --- | ---: | ---: |
| `cau` | 38 | 21.2% |
| `khu` | 33 | 18.4% |
| `yonsei` | 28 | 15.6% |
| `skku` | 23 | 12.8% |
| `korea` | 20 | 11.2% |
| `hanyang` | 19 | 10.6% |
| `ewha` | 9 | 5.0% |
| `uos` | 5 | 2.8% |
| `hongik` | 4 | 2.2% |

Phase 6 candidates by university prefix:

| Prefix | Count | Share |
| --- | ---: | ---: |
| `skku` | 14 | 16.7% |
| `yonsei` | 14 | 16.7% |
| `khu` | 12 | 14.3% |
| `hanyang` | 11 | 13.1% |
| `korea` | 9 | 10.7% |
| `cau` | 8 | 9.5% |
| `ewha` | 7 | 8.3% |
| `uos` | 5 | 6.0% |
| `hongik` | 4 | 4.8% |

Candidate coverage is not overly concentrated for ingest-path validation. It is still not enough to claim broad national coverage completeness.

## Observation-Performance Risk Classification

| Risk class | Count | Interpretation |
| --- | ---: | --- |
| explicit crawler failure | 2 | Known source-level failures that must not support deletion/missing judgments. |
| timeout/abort | 1 | Explicit transient/timeout risk. |
| HTTP error | 1 | Explicit access or URL health risk. |
| zero-crawled without explicit error | 5 | Possible selector/config/source-health risk. |
| crawled but no scholarship matched item | 427 | Observed one list item but did not classify it as scholarship-relevant. Could mean no recent scholarship item, keyword/filter under-detection, or one-item depth missed older relevant notices. |
| selector/config mismatch if available | 5 | Inferred from zero-crawled/no-error sources, not proven for all zero-match sources. |
| likely no recent scholarship notice | unknown | Cannot be proven from the existing output because the run only observed one item per source. |
| unknown reason | 427 | Crawled-but-zero-match sources require future observation-depth and matching analysis. |
| source type unsupported/not meaningfully parsed | 0 explicit | No explicit unsupported-source classification is present in the Phase 4 output. |
| potential false negative risk | 434 | All zero-match sources carry some false-negative risk until deeper observation/matching validation is run. |

Zero-match sources by parser strategy among crawled-but-no-match sources:

| Parser strategy | Count | Share |
| --- | ---: | ---: |
| `A_CONFIGURED_SELECTOR` | 219 | 51.3% |
| `B_COMMON_BOARD` | 163 | 38.2% |
| `C_HEURISTIC_ANCHOR` | 37 | 8.7% |
| `ADAPTER:yonsei_uic` | 4 | 0.9% |
| `ADAPTER:cau_artech` | 1 | 0.2% |
| `ADAPTER:hanyang_is` | 1 | 0.2% |
| `ADAPTER:korea_medicine` | 1 | 0.2% |
| `ADAPTER:yonsei_communication` | 1 | 0.2% |

Matched sources by parser strategy:

| Parser strategy | Count | Share |
| --- | ---: | ---: |
| `B_COMMON_BOARD` | 92 | 51.4% |
| `A_CONFIGURED_SELECTOR` | 65 | 36.3% |
| `C_HEURISTIC_ANCHOR` | 16 | 8.9% |
| `ADAPTER:cau_portal` | 6 | 3.4% |

## 179 To 84 Reduction Breakdown

The 95 items removed from the clean Phase 6 candidate set are explained by duplicate/provenance and quality gates, not by missing source/target/org-unit readiness.

| Reduction reason | Count |
| --- | ---: |
| total reduced out | 95 |
| duplicate/review candidates | 82 |
| quality-review candidates | 13 |
| clean new candidates not selected by strict clean filter | 6 |
| blocked quality operations | 26 |
| missing required field | 0 |
| schema issue | 0 |
| missing source | 0 |
| missing source target | 0 |
| missing org unit | 0 |
| unchanged candidates | 0 |
| changed candidates | 0 |

Top provenance flags:

| Flag | Count |
| --- | ---: |
| cross_source_candidate | 91 |
| duplicate_title_published_at_group | 91 |
| duplicate_canonical_url_within_input | 82 |
| duplicate_discovered_url_within_input | 82 |

Top quality flags:

| Flag | Count |
| --- | ---: |
| short_body | 13 |

## Decision Relevance

The current 84 candidates are meaningful for **guarded batch ingest mechanics** because:

- They are real Phase 4 observed items that survived Phase 5 source/target/org-unit readiness checks.
- They are not explained by the earlier personal-dev source-baseline gap; that gap was remediated before the final Phase 5 candidate plan.
- They are distributed across 84 source keys, so candidate concentration is not so narrow that ingest-path validation becomes meaningless.
- The remaining excluded items have clear review or quality reasons.

The current 84 candidates do **not** prove national coverage completeness because:

- Phase 4 observed at most one list item per source.
- 434 sources produced zero matched scholarship items, and the existing output cannot distinguish no recent scholarship notice from false negatives across all of them.
- Failure and zero-crawled sources remain unsafe for lifecycle or deletion conclusions.

## Phase 6 Recommendation

Recommendation: **CONDITIONAL PROCEED TO PHASE 6**.

Main reason: The 84 candidates are clean, source/target/org-unit ready, and distributed across 84 distinct source keys, so they are meaningful for guarded ingest-path validation; however, Phase 4's one-item-per-source observation and 434 zero-match sources leave coverage and false-negative risks for Phase 7/Post-Phase.

Risks that should not block Phase 6 but must carry forward:

- Phase 4 used CRAWL_MAX_ITEMS_PER_SOURCE=1, so pagination depth and older-notice discovery remain unproven.
- 434 of 613 sources produced zero matched scholarship items; 427 were crawled but no matched item was detected.
- 2 explicit failures and 5 zero-crawled/no-error sources must not be used for deletion or missing-notice judgments.
- 82 duplicate/review items and shared-board provenance require occurrence-policy review outside Phase 6 mechanics validation.
- 13 quality-review items, including short body cases, should remain excluded until extraction quality is improved.
- 103 no-assets items, including 48 clean candidates, are acceptable under the current policy but remain a product-quality tracking risk.

Risks that should block Phase 6:

- None identified from the available Phase 4/5 outputs, provided Phase 6 applies only the 84 clean candidates from the Phase 5 candidate plan and remains guarded/personal-dev scoped.

## Recommended Next Action

Proceed to Roadmap Phase 6 as a **conditional guarded ingest-path validation** using only the 84 clean candidates from:

```text
fixtures/crawler-ingest-dry-run/roadmap-phase5-phase6-candidate-plan.json
```

Do not use Phase 6 to claim coverage completeness. Carry source observation depth, zero-match source analysis, selector/config health, shared-board duplicate policy, and no-assets product-quality follow-up into Phase 7/Post-Phase.

Machine-readable companion report:

```text
fixtures/crawler-ingest-dry-run/roadmap-phase4-5-funnel-accountability.json
```
