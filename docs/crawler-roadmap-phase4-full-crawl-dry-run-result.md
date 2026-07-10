# Crawler Roadmap Phase 4 Full Crawl Dry-Run Result

## Status

Roadmap Phase 4 result: CONDITIONAL PASS.

The full crawl dry-run covered the complete 613-row source inventory with `CRAWL_MAX_ITEMS_PER_SOURCE=1`. It did not write to DB, did not source Supabase credentials, did not execute Supabase SQL, and did not run cleanup SQL.

This is a conditional pass because 606 of 613 sources crawled at least one list item, while 2 sources failed with explicit errors and 5 sources returned zero crawled items without an error.

## Command

```text
CRAWL_MAX_ITEMS_PER_SOURCE=1
CRAWL_LOOKBACK_DAYS=3650
CRAWL_ALLOW_UNDATED=false
CRAWL_IGNORE_SEEN=true
CRAWL_SOURCE_CONCURRENCY=8
CRAWL_TIMEOUT_MS=8000
CRAWL_RETRY_COUNT=0
node scripts/crawl-scholarship-notices.mjs data/notice-sources.csv exports/notices/roadmap-phase4-full-crawl-dry-run .crawler/roadmap-phase4-full-crawl-dry-run-state.json
```

Outputs:

```text
exports/notices/roadmap-phase4-full-crawl-dry-run/scholarship-notices-20260710.json
exports/notices/roadmap-phase4-full-crawl-dry-run/scholarship-notices-new-20260710.csv
.crawler/roadmap-phase4-full-crawl-dry-run-state.json
reports/roadmap-phase4-full-crawl-dry-run.summary.json
```

## Coverage Summary

| Metric | Value |
| --- | ---: |
| source coverage count | 613 |
| per-source result count | 613 |
| crawled source count | 606 |
| successful source count | 606 |
| failed/blocked source count | 2 |
| zero-crawled without explicit error | 5 |
| matched source count | 179 |
| total matched items | 179 |
| new item count | 179 |
| known item count | 0 |

Source health summary:

- 606 sources returned at least one crawled list item.
- 179 sources returned at least one scholarship-matched item.
- 179 matched items were written to local dry-run output only.
- No DB writes occurred.

## Failure Categories

| Category | Count | Sample |
| --- | ---: | --- |
| HTTP 404 | 1 | `cau_017` |
| aborted/timeout | 1 | `cau_025` |
| zero-crawled without explicit error | 5 | `hanyang_017`, `khu_058`, `khu_059`, `khu_060`, `khu_061` |

## Safety Confirmation

- DB writes occurred: false
- Supabase env bridge sourced: false
- Supabase SQL executed: false
- cleanup SQL executed: false
- batch apply executed: false
- production/main Supabase accessed: false
- Phase 4 DB write occurred: false

## Roadmap Phase 5 Readiness

Roadmap Phase 5 full output pre-apply/read-only plan can begin next: yes, with conditions.

Conditions:

- Treat the Phase 4 output as dry-run collector output only.
- Start Phase 5 with adapter conversion and read-only pre-apply planning.
- Do not apply the 179 matched items directly.
- Investigate or quarantine the 2 explicit failures and 5 zero-crawled sources before relying on missing/deletion judgments.
- Keep full-output DB comparison read-only until candidate classes are reviewed.

High-impact risks:

- The run used source-level max item count 1, so it validates broad source reachability but not complete pagination depth.
- Failure and zero-crawled sources make lifecycle/missing judgments unsafe for those sources.
- Some matched items may still have short body, missing assets, or source-specific extraction quality issues; Phase 5 must classify them before any write planning.
