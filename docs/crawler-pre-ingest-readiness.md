# Crawler Pre-Ingest Readiness

This document closes the schema/source-target preparation work immediately before ingest dry-run design. It does not start ingest design, notice ingest implementation, or crawler execution.

## 1. Current State

- Branch: `main`
- Target DB for later manual checks: personal dev Supabase only
- Production/main Supabase access: prohibited
- Crawler v2 schema: already applied in the personal dev DB
- `crawler_notice_sources`: sample source rows exist for `cau_001`, `cau_002`, and `yonsei_060`
- `org_units`: reported personal-dev compatibility stub is `id bigint not null` with row count `0`
- sample `org_unit_id` values are missing in personal dev:
  - `cau_001` -> `719`
  - `cau_002` -> `720`
  - `yonsei_060` -> `46`
- `crawler_source_targets`: reported row count `0`
- `crawler_source_targets` must be treated as a composite-key table. Do not assume an `id` column.

## 2. What Is Finished

- Source configuration is unified in `data/notice-sources.csv`.
- Crawler normalized schema v2 exists in `sql/create-crawler-normalized-schema-v2.sql`.
- `crawler_notice_sources` CSV dry-run sync exists.
- Guarded sample apply for `crawler_notice_sources` exists.
- `crawler_source_targets` CSV-only planner exists.
- Read-only DB check for source keys and `org_units(id)` exists.
- `org_units` strategy analysis exists in `docs/crawler-org-units-seed-strategy.md`.
- This pass adds:
  - a DB-free SQL generator,
  - a generated personal-dev review SQL draft,
  - guarded `crawler_source_targets` apply implementation,
  - operator commands and Go/No-Go criteria.

## 3. What Remains Before Ingest Dry-Run

Before ingest dry-run design starts, a human should:

1. Review `sql/drafts/prepare-org-units-for-crawler-targets.review.sql`.
2. Run only the precheck/read-only sections in personal dev Supabase.
3. If the schema still matches the expected id-only stub, run the transaction draft with `rollback;` first.
4. Review row counts and seed marker results.
5. Replace final `rollback;` with `commit;` only after manual approval.
6. Re-run `plan-crawler-source-targets.mjs --check-db` for the sample and then all CSV rows.
7. Only after source and org-unit readiness are both clean, run guarded `crawler_source_targets --apply` for a small sample.

## 4. CSV Inventory

Generated from `data/notice-sources.csv`:

| Metric | Value |
| --- | ---: |
| total rows | 613 |
| rows with `org_unit_id` | 613 |
| missing `org_unit_id` | 0 |
| invalid `org_unit_id` | 0 |
| unique `org_unit_id` | 605 |
| duplicate org_unit_id groups | 4 |
| shared board groups | 45 |
| shared board multi-org groups | 43 |

Source-level distribution:

| source_level | rows |
| --- | ---: |
| college | 12 |
| department | 599 |
| university | 2 |

Sample IDs:

| org_unit_id | present in CSV |
| ---: | --- |
| 46 | yes |
| 719 | yes |
| 720 | yes |

## 5. org_units Preparation Strategy

Recommended strategy remains the P0-3.6 option C:

- Do not run Phase1 or Phase2 SQL as-is.
- Add only minimal Phase1-compatible columns to the current `org_units` stub.
- Seed the 605 CSV unique `org_unit_id` values as explicit IDs.
- Preserve CSV provenance in `metadata`.
- Do not infer hierarchy when CSV does not prove parent-child relationships.
- Keep every operation in a review SQL draft that ends in `rollback;` by default.

Seed marker:

```text
crawler_csv_seed_p0_pre_ingest
```

The generated SQL uses `org_units.metadata ? 'crawler_csv_seed_p0_pre_ingest'` to identify provisional rows for review and cleanup.

## 6. Generated SQL Draft Path

Review SQL:

```text
sql/drafts/prepare-org-units-for-crawler-targets.review.sql
```

Generator:

```text
scripts/generate-org-units-seed-sql.mjs
```

Regenerate:

```bash
node scripts/generate-org-units-seed-sql.mjs
```

Safety properties:

- No DB connection
- No environment reads
- No Supabase calls
- Writes only the review SQL file
- Review SQL starts with `begin;`
- Review SQL ends with `rollback;`
- Reviewer must manually change `rollback;` to `commit;` to apply

## 7. crawler_source_targets Readiness

`scripts/plan-crawler-source-targets.mjs` now supports:

- CSV-only dry-run
- read-only DB check
- guarded personal-dev apply to `crawler_source_targets`

Apply remains blocked unless all are true:

- `--apply`
- `--yes-i-am-using-personal-dev-db`
- `PERSONAL_DEV_SUPABASE_CONFIRM=1`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `--limit N` with `N <= 10`
- `--prefix` or `--source-key`
- selected source keys already exist in `crawler_notice_sources`
- selected `org_unit_id` values already exist in `org_units`

The script upserts by `(source_id, org_unit_id)` and does not assume a `crawler_source_targets.id` column.

## 8. Guarded Apply Command Examples

Dry-run only:

```bash
node scripts/plan-crawler-source-targets.mjs --limit 5
node scripts/plan-crawler-source-targets.mjs --prefix cau --limit 5
```

Read-only sample check in personal dev:

```bash
PERSONAL_DEV_SUPABASE_CONFIRM=1 \
SUPABASE_URL=... \
SUPABASE_SERVICE_ROLE_KEY=... \
node scripts/plan-crawler-source-targets.mjs \
  --check-db \
  --source-key cau_001,cau_002,yonsei_060 \
  --yes-i-am-using-personal-dev-db
```

Guarded apply sample after org_units are prepared and read-only checks pass:

```bash
PERSONAL_DEV_SUPABASE_CONFIRM=1 \
SUPABASE_URL=... \
SUPABASE_SERVICE_ROLE_KEY=... \
node scripts/plan-crawler-source-targets.mjs \
  --apply \
  --source-key cau_001,cau_002,yonsei_060 \
  --limit 3 \
  --yes-i-am-using-personal-dev-db
```

Do not run apply against production. Do not print real URL/key values in shared logs.

## 9. Exact Commands User Should Run Later in Personal Dev Only

1. Regenerate review SQL if CSV changed:

```bash
node scripts/generate-org-units-seed-sql.mjs
```

2. Inspect `sql/drafts/prepare-org-units-for-crawler-targets.review.sql`.

3. In Supabase SQL Editor for personal dev only, run precheck sections first.

4. Run the full transaction with the default final `rollback;`.

5. If output is correct, manually change only the final `rollback;` to `commit;` and re-run in personal dev.

6. Verify sample readiness:

```bash
PERSONAL_DEV_SUPABASE_CONFIRM=1 \
SUPABASE_URL=... \
SUPABASE_SERVICE_ROLE_KEY=... \
node scripts/plan-crawler-source-targets.mjs \
  --check-db \
  --source-key cau_001,cau_002,yonsei_060 \
  --yes-i-am-using-personal-dev-db
```

7. Verify all CSV rows:

```bash
PERSONAL_DEV_SUPABASE_CONFIRM=1 \
SUPABASE_URL=... \
SUPABASE_SERVICE_ROLE_KEY=... \
node scripts/plan-crawler-source-targets.mjs \
  --check-db \
  --yes-i-am-using-personal-dev-db
```

8. Apply `crawler_source_targets` only after missing counts are zero, starting with `--limit 3` or another reviewed `N <= 10`.

## 10. Go/No-Go Criteria for Ingest Dry-Run Design

GO only if:

- `org_units` precheck matches an expected personal-dev stub or reviewed compatible schema.
- The 605 CSV unique `org_unit_id` rows exist after approved seed.
- `crawler_notice_sources` contains all source keys intended for target apply.
- `plan-crawler-source-targets.mjs --check-db` reports zero missing sources and zero missing org units for the selected scope.
- Guarded `crawler_source_targets` sample apply succeeds in personal dev.
- No production DB, secret output, crawler run, or notice ingest occurred.

NO-GO if:

- any required source key is missing.
- any required org unit ID is missing.
- the SQL draft is not reviewed by a human.
- the DB schema differs in a way that makes the additive draft unsafe.
- guarded apply needs more than the current `N <= 10` cap before sample validation.

Current repository state after this preparation is NO-GO for ingest dry-run execution until human/Supabase actions complete. It is GO for reviewing and applying the personal-dev readiness SQL.

## 11. Risks Intentionally Accepted to Reduce Overhead

- The seed is provisional and personal-dev oriented.
- CSV metadata is used to create fallback names and preserve provenance, not to prove the full hierarchy.
- `path_ids` are initialized as `array[id]` for provisional parentless rows.
- `unit_type` is inferred from CSV `source_level`.
- Full Phase1/Phase2 service-schema restoration is deferred.
- `crawler_source_targets` apply is implemented before running a real write, but guarded and capped.

## 12. Risks Still Not Accepted

- production/main Supabase access
- team production DB access
- secret leakage
- unguarded writes
- notice ingest before schema readiness
- crawler execution before ingest design
- destructive edits to `data/notice-sources.csv`
- destructive edits to Phase1/Phase2 source SQL
- assuming `crawler_source_targets.id`
- applying target rows when source or org-unit FK readiness is incomplete
