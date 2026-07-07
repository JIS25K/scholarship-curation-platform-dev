# Scripts Maintenance Guide

This document classifies non-core scripts under `scripts/` by operational priority.

## Keep For Operations

These scripts support recurring crawler operations or incident diagnosis.

- `scripts/summarize-crawled-feedback.mjs`
  - Aggregates review outcomes from Supabase for feedback-loop tuning.
- `scripts/merge-notice-source-configs.mjs`
  - Verifies that the canonical crawler source file, `data/notice-sources.csv`, keeps the required operational columns and unique source IDs.
- `scripts/report-dead-link-candidates.mjs`
  - Categorizes failed sources into dead/blocked/timeout candidates.

## Keep For Analysis And QA

These scripts are useful during alignment, migration, and quality audits.

- `scripts/compare-crawler-departments.mjs`
- `scripts/compare-crawler-vs-db-by-university.mjs`
- `scripts/export-university-department-comparison.mjs`
- `scripts/export-ewha-department-diff-csv.mjs`
- `scripts/export-seed-scholarships-csv.mjs`
- `scripts/generate-special-info-patch.mjs`

## Removed Scripts

- `scripts/compare-ewha-ext-crawler.mjs`
  - Removed because it depended on a local absolute OneDrive path and was not portable.

## Usage Notes

- Treat scripts in this document as developer utilities unless they are explicitly called by CI/workflows.
- Prefer environment-driven paths over machine-specific absolute paths.
- If a script becomes part of daily operations, add an npm script alias in `package.json` and reference it in docs/workflows.
