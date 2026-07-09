# Crawler Real Output Ingest Adapter

## Purpose

This adapter connects local collector/report JSON to the existing crawler ingest dry-run fixture contract. It does not perform DB writes, SQL execution, Supabase calls, source sync apply, notice ingest, or crawler execution.

## Why This Follows Ingest Dry-Run

The previous ingest dry-run proved that synthetic fixture input can map into planned v2 crawler operations. This step keeps the same dry-run planner, but adds a local conversion layer so stored collector/report output can be reviewed before any real ingest path exists.

## Files Inspected

- `scripts/ingest-crawler-run-dry-run.mjs`
- `fixtures/crawler-ingest-dry-run/sample-notices.json`
- `docs/crawler-ingest-dry-run.md`
- `docs/crawler-pre-ingest-readiness.md`
- `sql/create-crawler-normalized-schema-v2.sql`
- `docs/crawler-db-schema-v2.md`
- `data/notice-sources.csv`
- `package.json`
- `scripts/crawl-scholarship-notices.mjs`
- `scripts/audit-crawler-capabilities.mjs`
- local ignored reports under `exports/notices/diagnostics/`

## Candidate Collector/Report Output Shapes

| Candidate | Shape | Ingest suitability |
| --- | --- | --- |
| `fixtures/crawler-ingest-dry-run/sample-notices.json` | `sources[].items[]` | Direct synthetic-compatible fixture. Useful adapter regression input. |
| `reports/ingest-dry-run-sample.json` | dry-run report with `planned_operations` | Not a collector input. Useful only as prior dry-run output. |
| `scripts/crawl-scholarship-notices.mjs` output | `newNotices[]`, `perSource[]` | Supported by adapter, but no current local `scholarship-notices-latest.json` report was found. |
| `exports/notices/diagnostics/capability-audit-20260706-20260706-073155.json` | `perSource[].samples.notices[]` | Chosen real local report candidate. Contains source IDs, titles, URLs, and dates, but not detail body/assets. |
| `exports/notices/diagnostics/needs-adapter-latest.json` | `needsAdapter[]` with source diagnostics | Diagnostic source list, not enough as primary notice input. |
| `exports/notices/diagnostics/manual-review-required-latest.json` | `manualReviewRequired[]` with source diagnostics | Diagnostic source list, not enough as primary notice input. |
| `exports/notices/diagnostics/failed-sources-latest.json` | `failedSources[]` with source diagnostics | Diagnostic source list, not enough as primary notice input. |

## Chosen Adapter Input Format

The adapter supports:

- `synthetic-compatible`: existing `sources[].items[]` fixture input.
- `collector-report`: crawler run reports with `newNotices[]` and audit reports with `perSource[].samples.notices[]`.
- `candidate-list`: arrays or objects containing `items`, `notices`, `candidates`, `results`, `records`, `rows`, or `data`.
- `auto`: default detection.

The committed real sample fixture was generated from:

```text
exports/notices/diagnostics/capability-audit-20260706-20260706-073155.json
```

with `--source-key cau_univ_001 --limit 5`. The source report itself remains ignored and is not committed.

## Field Mapping

| Fixture field | Source fields |
| --- | --- |
| `source_key` | `source_key`, `sourceId`, `source_id`, or CLI `--source-key` fallback |
| `title` | `title`, `listTitle`, `list_title`, `name`, `subject` |
| `discovered_url` | `discovered_url`, `noticeUrl`, `notice_url`, `url`, `href`, `link`, `detail_url` |
| `canonical_url` | `canonical_url`, `final_url`, `finalUrl`, `resolved_url`, or discovered URL |
| `published_at` | `published_at`, `posted_at`, `parsedDate`, `parsed_date`, `detailDate`, `dateText`, `date` |
| `body_text` | `body_text`, `bodyText`, `content`, `body`, `text`, `detailText` |
| `body_quality` | source body quality when present, otherwise `adapted` or `empty` |
| `assets` | `assets`, `attachments`, `files`, `images`, `attachment` |
| `warnings/errors` | missing URL/body warnings, audit sample warning, adapter skipped/errors metadata |

Unknown raw item fields are preserved under `metadata.raw` with truncation and secret-like keys removed.

## Adapter CLI Usage

```bash
node scripts/adapt-collector-output-for-ingest-dry-run.mjs \
  --input fixtures/crawler-ingest-dry-run/sample-notices.json \
  --source-key cau_002 \
  --limit 5 \
  --out fixtures/crawler-ingest-dry-run/adapted-sample.json
```

```bash
node scripts/adapt-collector-output-for-ingest-dry-run.mjs \
  --input exports/notices/diagnostics/capability-audit-20260706-20260706-073155.json \
  --source-key cau_univ_001 \
  --limit 5 \
  --out fixtures/crawler-ingest-dry-run/adapted-real-sample.json
```

Package script:

```bash
npm run crawler:ingest:adapt -- --input <path> --source-key <source_key> --out <path>
```

## End-to-End Dry-Run Commands

```bash
node scripts/ingest-crawler-run-dry-run.mjs \
  --fixture fixtures/crawler-ingest-dry-run/adapted-sample.json \
  --source-key cau_002 \
  --limit 5 \
  --json \
  --out reports/ingest-dry-run-adapted-sample.json
```

```bash
node scripts/ingest-crawler-run-dry-run.mjs \
  --fixture fixtures/crawler-ingest-dry-run/adapted-real-sample.json \
  --source-key cau_univ_001 \
  --limit 5 \
  --json \
  --out reports/ingest-dry-run-adapted-real-sample.json
```

## Dry-Run Result Summary

Synthetic-compatible adapted sample:

| Metric | Value |
| --- | ---: |
| sources | 1 |
| input_items | 3 |
| planned_runs | 1 |
| planned_source_results | 1 |
| planned_notices | 2 |
| planned_url_aliases | 3 |
| planned_occurrences | 3 |
| planned_targets | 2 |
| planned_assets | 1 |
| planned_keyword_matches | 2 |
| planned_errors | 2 |
| skipped | 0 |
| schema_blockers | 0 |

Real local audit-report adapted sample:

| Metric | Value |
| --- | ---: |
| sources | 1 |
| input_items | 5 |
| planned_runs | 1 |
| planned_source_results | 1 |
| planned_notices | 5 |
| planned_url_aliases | 5 |
| planned_occurrences | 5 |
| planned_targets | 5 |
| planned_assets | 0 |
| planned_keyword_matches | 4 |
| planned_errors | 5 |
| skipped | 0 |
| schema_blockers | 0 |

Safety flags:

- `db_write_executed=false`
- `supabase_sql_executed=false`
- `crawler_executed=false`

## Known Gaps

- No local `scholarship-notices-latest.json` collector run report was available during this pass.
- The chosen real local audit report has list-level samples only, so `body_text` is empty and each real-sample item produces a planned body warning.
- The chosen audit report does not include attachment or asset metadata.
- Adapter metadata is intentionally truncated and does not preserve large full HTML fields.
- This step does not prove personal-dev DB readiness for the adapted real sample source.

## Go/No-Go Criteria for Next Phase

GO for a next dry-run-oriented phase when:

- adapter output has at least one source and item.
- ingest dry-run reports `schema_blockers=0`.
- dry-run safety flags remain false for DB write, SQL execution, and crawler execution.
- source-target mapping exists locally in `data/notice-sources.csv`.

NO-GO for real ingest apply when:

- source body/detail output is missing.
- DB readiness has not been checked read-only for the selected source scope.
- planned payloads have not been reviewed.
- any write path is requested before a separate guarded personal-dev-only design.

## Recommended Next Phase

Recommended next phase: B. Generate stored collector output for 3 sample sources, then connect it to the adapter.

That should produce a real `scholarship-notices-latest.json` or equivalent collector output containing detail body and asset fields. After that, option C can combine ingest dry-run reports with read-only DB checks. Option D, a limited personal-dev-only real ingest apply design, should remain deferred.
