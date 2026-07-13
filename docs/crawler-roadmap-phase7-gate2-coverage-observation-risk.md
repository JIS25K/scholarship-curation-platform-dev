# Crawler Roadmap Phase 7 Gate 2 Coverage Observation Risk

Roadmap Phase 7 - Gate 2 result: **CONDITIONAL PASS**.

Gate 2 analyzed the coverage and observation-quality risks left by Phase 4. It did not rerun Phase 6, did not write to DB, did not apply new crawl output, did not execute raw/arbitrary Supabase SQL, did not run cleanup SQL, did not access production/main Supabase, and did not run an uncontrolled deep crawl.

## Executive Summary

| Question | Answer |
| --- | --- |
| Gate 2 result | CONDITIONAL PASS |
| Gate 3 can begin next | yes |
| Does Phase 4 conditional risk block data pipeline confirmation? | no |
| Is national coverage completeness proven? | no |
| Is the remaining risk primarily coverage/observation quality? | yes |
| Was a bounded dry-run executed in Gate 2? | false |

Phase 4's `CRAWL_MAX_ITEMS_PER_SOURCE=1` made the observed output intentionally shallow. It proved that the crawler could cover the source inventory and collect/match at least one observed item for many sources, but it did not prove that zero-match sources lack scholarship notices deeper in pagination.

The 434 zero-match sources should be interpreted as **no scholarship match observed in the shallow run**, not as **no scholarship notice exists**.

Phase 6 already validated the guarded normalized personal-dev ingest mechanics for 84 clean candidates from 84 distinct source keys. Gate 2 found no evidence that the Phase 4 conditional risk is a DB/schema/ingest executor structure blocker.

## Source-Level Funnel Recap

| Metric | Value |
| --- | --- |
| canonical sources | 613 |
| covered sources | 613 |
| crawled at least one item | 606 |
| explicit failures | 2 |
| zero-crawled without explicit error | 5 |
| matched source count | 179 |
| zero-match source count | 434 |
| Phase 6 candidate source count | 84 |

## Zero-Match Source Classification

### Counts

| Classification | Count | Confidence |
| --- | --- | --- |
| explicit crawler failure | 2 | confirmed |
| zero-crawled without explicit error | 5 | confirmed observation; root cause not proven |
| crawled but no scholarship match observed | 427 | confirmed observation; root cause not proven |
| confirmed no recent scholarship notice | 0 | not provable from existing artifacts |
| likely selector/config mismatch | 5 | possible, not proven |
| confirmed matching false negative | 0 | not provable from existing artifacts |
| potential false-negative risk | 434 | risk category |
| explicit unsupported source structure | 0 | no explicit label in artifacts |
| needs deeper inspection | 434 | required before coverage claim |

### Parser Strategy Distribution

| Parser strategy | Zero-match sources |
| --- | --- |
| A_CONFIGURED_SELECTOR | 223 |
| B_COMMON_BOARD | 164 |
| C_HEURISTIC_ANCHOR | 37 |
| ADAPTER:yonsei_uic | 4 |
| none | 2 |
| ADAPTER:cau_artech | 1 |
| ADAPTER:hanyang_is | 1 |
| ADAPTER:korea_medicine | 1 |
| ADAPTER:yonsei_communication | 1 |

### Representative Examples

Explicit failure examples:

- `cau_017`: HTTP 404
- `cau_025`: This operation was aborted

Zero-crawled/no-error examples:

- `hanyang_017`: parser=B_COMMON_BOARD
- `khu_058`: parser=A_CONFIGURED_SELECTOR
- `khu_059`: parser=A_CONFIGURED_SELECTOR
- `khu_060`: parser=A_CONFIGURED_SELECTOR
- `khu_061`: parser=A_CONFIGURED_SELECTOR

High-priority inspection queue count: **52**.

This queue combines explicit failures, zero-crawled/no-error sources, heuristic-parser zero-match sources, adapter zero-match sources, and parser-missing zero-match sources. It is a prioritization queue, not proof that every listed source is broken.

## Observation Depth Analysis

### Impact Of CRAWL_MAX_ITEMS_PER_SOURCE=1

Max=1 proved:

- The crawler could cover the 613-row source inventory locally.
- 606 sources yielded at least one crawled list/detail item.
- The keyword/date matching and local report output path worked on shallow observed data.
- 179 sources produced at least one scholarship-matched item.

Max=1 did not prove:

- Absence of scholarship notices deeper in pagination.
- False-negative rate across zero-match sources.
- Lifecycle or deletion safety for failure and zero-crawled sources.
- National coverage completeness.

Increasing max items per source to 3 or 5 may reveal scholarship notices where the first observed item was unrelated, increase duplicate/provenance groups, and expose parser/detail extraction weaknesses. The current crawler already supports `CRAWL_MAX_ITEMS_PER_SOURCE`, and the normalized ingest path can receive deeper observed output through the existing dry-run and planning layers without a schema change.

## False-Negative Risk Assessment

| Risk | Conclusion |
| --- | --- |
| overall severity | medium_high_for_coverage_claims |
| title/body keyword matching | Existing artifacts cannot prove misses where the first crawled item used non-scholarship wording or where body extraction was weak. |
| shallow observation | High: max=1 is the largest known limitation for zero-match interpretation. |
| selector/content extraction | Medium: five zero-crawled/no-error sources are possible selector/config/source-health issues. |
| pagination | High until max=3 or max=5 bounded dry-runs compare match lift. |
| source structure diversity | Medium: zero-match sources span configured selector, common board, heuristic, and adapter paths. |
| no_assets/body quality | Operational/review risk, not a Gate 2 ingest-structure blocker. |

## Pipeline Structure Risk Assessment

| Question | Answer |
| --- | --- |
| Does current evidence suggest a DB/ingest structure blocker? | no |
| Does current evidence suggest the remaining risk is primarily coverage/observation quality? | yes |
| Can the data pipeline be considered structurally validated while coverage improvement continues? | conditional yes |

Rationale: Phase 6 applied clean84 through the normalized personal-dev ingest path. Phase 4's conditional risk is explained by shallow observation and source-health uncertainty, not by schema/executor incompatibility.

## Mitigation Performed

- Added a reproducible local-only Gate 2 analysis script.
- Generated a machine-readable coverage/observation risk JSON fixture.
- Generated a Gate 2 Markdown report that distinguishes no match observed from no scholarship exists.
- Generated an ignored local source-health queue report for bounded deeper dry-run planning.
- Documented bounded max=3/max=5 dry-run scopes instead of running an uncontrolled full deep crawl.

No bounded crawler dry-run was executed in Gate 2 because the existing Phase 4 artifacts are sufficient to classify the risk type, and an uncontrolled full deep crawl is explicitly out of scope. The safe next mitigation is a bounded max=3/max=5 dry-run against the queues below.

## Deeper Dry-Run Recommendation

Recommended before Gate 3: **no**.

Recommended before final production readiness: **yes**.

Recommended after Phase 7 as post-phase coverage improvement: **yes**.

Safe scopes:

- failure-and-zero-crawled-probe: 7 sources, max=3. Separate transient failures, dead URLs, selector/config issues, and empty-list behavior.
- high-priority-zero-match-sample: 52 sources, max=5. Inspect weak/heuristic/adapter and zero-crawled groups without crawling all 613 sources.
- representative-parser-strategy-sample: 22 sources, max=5. Compare match lift across parser strategies before a broader crawl.

Command template:

```powershell
$env:CRAWL_MAX_ITEMS_PER_SOURCE='5'; $env:CRAWL_SOURCE_CONCURRENCY='2'; $env:CRAWL_IGNORE_SEEN='true'; $env:CRAWL_LOOKBACK_DAYS='3650'; $env:CRAWL_SOURCE_ID_ALLOWLIST='<comma-separated-source-keys>'; node scripts/crawl-scholarship-notices.mjs data/notice-sources.csv exports/notices/roadmap-phase7-gate2-bounded-dry-run .crawler/roadmap-phase7-gate2-bounded-dry-run-state.json
```

## Carry-Forward Risks

### Gate 3

- duplicate/review 82
- quality-review 13
- no_assets 48 applied candidates
- cleanup/rollback procedure
- aggregate batch observability
- final production readiness decision

### Post-Phase

- Run bounded deeper dry-runs for failure/zero-crawled and high-priority zero-match samples.
- Compare max=1 vs max=3/max=5 match lift before any national coverage claim.
- Investigate 434 zero-match sources as no-match-observed, not no-scholarship-exists.
- Improve source-health queues for repeated failures and selector/config drift.

## Gate 2 Decision

Roadmap Phase 7 - Gate 2 result: **CONDITIONAL PASS**.

Decision reason: No DB/ingest structural blocker was found, but zero-match classification remains partial and deeper observation is required before final production readiness.

Roadmap Phase 7 - Gate 3 can begin next: **yes**.
