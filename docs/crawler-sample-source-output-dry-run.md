# Crawler Sample Source Output Dry-Run

## Purpose

This pass validates the local path from limited sample collector output to adapter fixture to crawler ingest dry-run. It is not a real ingest apply and does not write to Supabase.

Sample sources:

- `cau_001`
- `cau_002`
- `yonsei_060`

## Safety Boundary

- DB writes executed: `false`
- Supabase SQL executed: `false`
- source sync apply executed: `false`
- crawler_source_targets apply executed: `false`
- notice ingest executed: `false`
- production/main Supabase access: `false`

A limited collector run was executed only for the three sample source keys, with `CRAWL_MAX_ITEMS_PER_SOURCE=3`, to create local JSON output.

## Collector Command

```bash
CRAWL_SOURCE_ID_ALLOWLIST=cau_001,cau_002,yonsei_060 \
CRAWL_MAX_ITEMS_PER_SOURCE=3 \
CRAWL_LOOKBACK_DAYS=3650 \
CRAWL_ALLOW_UNDATED=true \
CRAWL_IGNORE_SEEN=true \
CRAWL_SOURCE_CONCURRENCY=1 \
CRAWL_TIMEOUT_MS=10000 \
CRAWL_RETRY_COUNT=0 \
node scripts/crawl-scholarship-notices.mjs \
  data/notice-sources.csv \
  exports/notices/sample-source-dry-run \
  .crawler/sample-source-output-state.json
```

Local ignored raw output:

```text
exports/notices/sample-source-dry-run/scholarship-notices-latest.json
```

Committed collector-style fixture:

```text
fixtures/crawler-ingest-dry-run/collector-output-sample-sources.json
```

## Sample Source Results

| Source | Crawled | Matched | Adapter items | Body quality | Asset quality | Diagnostics |
| --- | ---: | ---: | ---: | --- | --- | --- |
| `cau_001` | 3 | 0 | 0 | `empty_or_no_items` | `no_assets_found` | `no_matched_scholarship_notices`, `no_adapter_items_for_ingest_dry_run` |
| `cau_002` | 3 | 3 | 3 | `short_or_empty` | `no_assets_found` | item-level `short_body_text`, `no_assets_found` |
| `yonsei_060` | 3 | 1 | 1 | `mixed_with_detail_body` | `no_assets_found` | item-level `no_assets_found` |

No source reported network timeout, 403, or collector exception during this limited run.

## Collector Output Shape

The committed collector-style fixture uses:

- `collector_output_version`
- `generated_from`
- `generated_at`
- `sample_sources`
- `crawler_scope`
- `totals`
- `sources[]`

Each source contains:

- `source_key`
- `source_name`
- `parser_strategy`
- `parser_recovered`
- `crawled_count`
- `matched_count`
- `new_count`
- `body_quality`
- `asset_quality`
- `warnings`
- `errors`
- `items[]`

Each item contains:

- `source_key`
- `title`
- `discovered_url`
- `canonical_url`
- `published_at`
- `body_text`
- `body_html`
- `body_quality`
- `assets`
- `warnings`
- `errors`
- `raw`

## Adapter Mapping

`scripts/adapt-collector-output-for-ingest-dry-run.mjs` now supports `--format collector-output`.

Mapping rules:

- `sources[].source_key` becomes fixture `sources[].source_key`.
- `sources[].items[]` becomes fixture `sources[].items[]`.
- empty sources are preserved with `items: []` so source-level diagnostics are not hidden.
- source diagnostics are preserved in `adapter.source_diagnostics`.
- item `discovered_url`, `canonical_url`, `published_at`, `body_text`, `body_html`, `body_quality`, `assets`, and `warnings` follow the existing ingest dry-run fixture contract.
- no DB generated columns are added by the adapter.

Adapter command:

```bash
node scripts/adapt-collector-output-for-ingest-dry-run.mjs \
  --input fixtures/crawler-ingest-dry-run/collector-output-sample-sources.json \
  --format collector-output \
  --out fixtures/crawler-ingest-dry-run/adapted-collector-output-sample-sources.json
```

Adapter output:

```text
fixtures/crawler-ingest-dry-run/adapted-collector-output-sample-sources.json
```

Adapter summary:

| Metric | Value |
| --- | ---: |
| detected_format | `collector-output` |
| input_items_seen | 4 |
| matching_items_seen | 4 |
| output_items | 4 |
| sources | 3 |
| skipped | 0 |
| adapter_errors | 0 |

## Ingest Dry-Run Summary

Command:

```bash
node scripts/ingest-crawler-run-dry-run.mjs \
  --fixture fixtures/crawler-ingest-dry-run/adapted-collector-output-sample-sources.json \
  --limit 10 \
  --json \
  --out reports/ingest-dry-run-sample-source-output.json
```

Ignored report:

```text
reports/ingest-dry-run-sample-source-output.json
```

Summary:

| Metric | Value |
| --- | ---: |
| sources | 3 |
| input_items | 4 |
| planned_runs | 1 |
| planned_source_results | 3 |
| planned_notices | 4 |
| planned_url_aliases | 4 |
| planned_occurrences | 4 |
| planned_targets | 4 |
| planned_assets | 0 |
| planned_keyword_matches | 10 |
| planned_errors | 4 |
| skipped | 0 |
| schema_blockers | 0 |

Dry-run safety flags:

- `db_write_executed=false`
- `supabase_sql_executed=false`
- `crawler_executed=false`

## Body And Asset Quality

- `cau_001`: no matched scholarship notices in the limited sample, so no ingest item was fabricated.
- `cau_002`: matched list/detail candidates exist, but body text is short department/category-style text. These are preserved with `short_body_text` diagnostics.
- `yonsei_060`: one matched item includes a detail body and HTML, but no assets were extracted into normalized asset records.

## Go/No-Go

GO for the next dry-run-only phase:

- sample source output can be converted through `collector-output -> adapter fixture -> ingest dry-run`.
- all three sample source keys remain represented.
- dry-run reports `schema_blockers=0`.
- source targets are resolved locally from `data/notice-sources.csv`.

NO-GO for real ingest apply:

- `cau_001` has no matched item in the limited sample.
- `cau_002` body quality is short.
- assets are not yet extracted for the sample output.
- DB read-only readiness was not re-run for this new adapted fixture scope.

## Recommended Next Phase

Recommended next phase: improve duplicate, change, and stale/deletion dry-run diagnostics using this sample collector-output fixture.

After that, improve run/error/body-quality reporting so short body text, missing assets, no matched notices, and source-level zero-item cases remain visible before any personal-dev-only ingest apply design.
