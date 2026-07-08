# Crawler org_units Seed Strategy

## 1. Background

P0-3.5 proved that `scripts/plan-crawler-source-targets.mjs --check-db` can safely verify source-target readiness without writing to Supabase. The user-run personal dev DB check showed:

- sample `source_key` rows exist in `public.crawler_notice_sources`.
- `crawler_notice_sources.source_key -> crawler_notice_sources.id` lookup works.
- `crawler_source_targets` writes were not executed.
- the current blocker is missing `public.org_units.id` rows, for example `cau_002 -> org_unit_id=720` and `yonsei_060 -> org_unit_id=46`.

P0-3.6 does not modify DB state. This document analyzes how to prepare `org_units` for a later guarded `crawler_source_targets` apply.

## 2. Current Blocker

`public.crawler_source_targets` in crawler normalized schema v2 has two foreign keys:

```sql
source_id bigint not null references public.crawler_notice_sources(id) on delete cascade,
org_unit_id bigint not null references public.org_units(id) on delete restrict
```

The source side is ready for the sample rows. The target side is not ready because the personal dev DB currently has only a minimal compatibility `org_units` stub and does not contain the CSV-required `org_unit_id` values.

Until those IDs exist, `crawler_source_targets` apply should remain blocked.

## 3. Files Reviewed

- `sql/org-units-phase1-schema-and-backfill.sql`
- `sql/org-units-phase2-targeting-and-matching.sql`
- `sql/create-crawler-normalized-schema-v2.sql`
- `docs/crawler-db-schema-v2.md`
- `data/notice-sources.csv`
- `scripts/plan-crawler-source-targets.mjs`
- `scripts/sync-crawler-notice-sources.mjs`

No Supabase SQL was executed. No DB connection was used for this document.

## 4. Current Stub vs Phase1 `org_units` Schema

Current personal dev DB stub, as reported in the handoff, is compatible only with FK existence checks:

```sql
public.org_units(id bigint primary key)
```

Phase1 expects a richer hierarchy table:

```sql
create table if not exists public.org_units (
  id           bigint generated always as identity primary key,
  parent_id    bigint null references public.org_units(id) on delete restrict,
  unit_type    public.org_unit_type not null,
  name         text not null,
  path_ids     bigint[] not null default '{}',
  field_code   text null,
  legacy_table text null,
  legacy_id    bigint null,
  created_at   timestamptz not null default now(),
  unique (parent_id, name)
);
```

Important differences:

- The stub has only `id`; Phase1 requires `parent_id`, `unit_type`, `name`, `path_ids`, `field_code`, `legacy_table`, `legacy_id`, and `created_at`.
- Phase1 creates enum `public.org_unit_type`.
- Phase1 uses `id bigint generated always as identity`.
- Phase1 adds root-name and legacy unique indexes, parent/path indexes, path-maintenance triggers, RLS policies, and `org_unit_aliases`.
- Phase1 backfills from `public.universities`, `public.university_colleges`, and `public.university_departments`.
- Phase1 alters `public.profiles` by adding `org_unit_id` and `double_major_org_unit_id`.

Applying Phase1 as-is on top of the stub is not safe. Because the table already exists, `create table if not exists public.org_units (...)` will not add the missing columns. Later statements that reference `path_ids`, `legacy_table`, `unit_type`, and `name` can then fail.

## 5. CSV `org_unit_id` Inventory

Local CSV analysis of `data/notice-sources.csv`:

| Metric | Value |
| --- | ---: |
| total rows | 613 |
| rows with `org_unit_id` | 613 |
| missing `org_unit_id` | 0 |
| invalid `org_unit_id` | 0 |
| unique `org_unit_id` | 605 |
| duplicate `org_unit_id` groups | 4 |
| rows in duplicate groups | 12 |
| min `org_unit_id` | 2 |
| max `org_unit_id` | 1127 |

Duplicate `org_unit_id` groups:

| org_unit_id | count | examples |
| ---: | ---: | --- |
| 1084 | 2 | `hongik_005`, `hongik_006` |
| 1115 | 2 | `hongik_014`, `hongik_015` |
| 1105 | 4 | `hongik_021`, `hongik_024`, `hongik_027`, `hongik_028` |
| 46 | 4 | `yonsei_060`, `yonsei_061`, `yonsei_062`, `yonsei_063` |

Source-level counts:

| source_level | rows |
| --- | ---: |
| university | 2 |
| college | 12 |
| department | 599 |

Metadata gaps in CSV:

| column | empty rows |
| --- | ---: |
| `university_id` | 0 |
| `college_id` | 3 |
| `department_id` | 23 |
| `org_unit_id` | 0 |
| `college_name` | 389 |
| `department_name` | 6 |

The old estimate of 605 unique `org_unit_id` values is correct for the current CSV.

CSV can support a minimal seed because every source row has a valid positive `org_unit_id`. It is not sufficient to reconstruct the full production hierarchy with high confidence because many `college_name` values are blank, some `department_id` values are blank, and the CSV does not carry parent `org_unit_id` relationships or canonical `path_ids`.

Fallback naming for CSV-only seed should be deterministic and visibly provisional:

- prefer `department_name` when present.
- else prefer `college_name` when present.
- else use `source_name`.
- as a final fallback use `csv-org-unit-<org_unit_id>`.

## 6. Phase1 SQL Analysis

Phase1 does the following:

- creates enum `public.org_unit_type` with `university`, `college`, `division`, `department`.
- creates `public.org_units` as a hierarchy table with `parent_id`, `unit_type`, `name`, `path_ids`, `field_code`, legacy mapping columns, and timestamps.
- creates unique/index constraints:
  - `unique(parent_id, name)`
  - `uq_org_units_root_name` on root `name`
  - `uq_org_units_legacy` on `(legacy_table, legacy_id)` when `legacy_table is not null`
  - `idx_org_units_parent_id`
  - `idx_org_units_path_ids` using GIN
- creates triggers/functions to maintain `path_ids`.
- creates `public.org_unit_aliases`.
- enables RLS and admin/public policies using `public.is_admin()`.
- backfills `org_units` from `universities`, `university_colleges`, and `university_departments`.
- adds `profiles.org_unit_id` and `profiles.double_major_org_unit_id`.
- verifies total counts, broken paths, and unmapped profiles.

Risks in the current personal dev DB:

- Not directly compatible with `public.org_units(id bigint primary key)` stub because `create table if not exists` will not alter the existing stub.
- May depend on legacy service tables already being present and populated: `universities`, `university_colleges`, `university_departments`, and `profiles`.
- May depend on `public.is_admin()`.
- Generated identity IDs are not guaranteed to match CSV `org_unit_id` values unless the same source data and insertion order reproduce the original IDs. CSV target verification requires exact ID matches.
- It changes application-facing schema (`profiles`) and RLS/policies, which is beyond the minimal target-FK verification need.

Conclusion: Phase1 is useful as the target shape, but should not be run as-is on the current stub during P0-3.6/P0-3.7.

## 7. Phase2 SQL Analysis

Phase2 assumes Phase1 has completed. It does the following:

- creates `public.scholarship_target_units`, joining `scholarships` to `org_units`.
- adds `public.scholarships.qual_field_codes text[]`.
- adds a GIN index for `qual_field_codes`.
- rewrites `public.get_matched_scholarships(uuid)` to use `org_units.path_ids`, `profiles.org_unit_id`, `profiles.double_major_org_unit_id`, `scholarship_target_units`, and `qual_field_codes`.
- grants/revokes function execution.

Phase2 is not required for `crawler_source_targets` verification. The crawler v2 FK only needs:

- `crawler_notice_sources.id` values for source keys.
- `org_units.id` values for CSV `org_unit_id`.

Applying Phase2 now is risky because it changes scholarship matching behavior and assumes the broader service schema has been restored. It should be deferred until the personal dev DB has a coherent service schema and Phase1-compatible `org_units`.

## 8. Strategy Comparison

### A. Apply existing Phase1/Phase2 SQL as-is

Pros:

- Closest to intended service architecture if all dependencies exist.
- Restores hierarchy, aliases, profile mapping, and matching semantics.

Risks:

- Phase1 is not safe over the current stub because missing columns are not added by `create table if not exists`.
- Phase2 changes application matching behavior and depends on Phase1 and service tables.
- Exact CSV `org_unit_id` values may still not be reproduced.
- Too broad for crawler-source-target FK validation.

Verdict: No-go for current stage.

### B. Seed only unique CSV `org_unit_id` values into current stub

Pros:

- Minimal change.
- Sufficient for FK existence checks if `org_units(id)` is the only required column.
- Easy to roll back if no dependent rows exist.

Risks:

- If `org_units` already has NOT NULL columns beyond `id`, insert fails.
- Does not move DB closer to Phase1 schema.
- No names, hierarchy, `path_ids`, or metadata for later matching.
- Later Phase1 migration may collide with existing explicit IDs or need careful adoption logic.

Verdict: Useful only if the table truly remains `id`-only. Too brittle as the recommended path.

### C. ALTER stub to Phase1-compatible minimal schema, then CSV-based explicit ID seed

Pros:

- Keeps scope focused on crawler target verification.
- Makes `org_units` compatible with crawler v2 FKs and closer to Phase1 shape.
- Allows deterministic explicit IDs from CSV.
- Can add provisional names and `path_ids = array[id]` so rows are internally consistent.
- Avoids Phase2 behavioral changes.

Risks:

- Still not a full service-schema restoration.
- Provisional parentless rows do not encode the real university/college/department hierarchy.
- Requires careful future migration/adoption to avoid conflict with full Phase1 backfill.
- Existing stub data must be inspected first.

Verdict: Recommended for P0-3.7, with read-only prechecks and a transaction-wrapped SQL draft reviewed before execution.

### D. Reset personal dev DB and restore full service schema in order

Pros:

- Cleanest long-term path if migration inventory is complete.
- Most production-like environment.
- Avoids awkward stub adoption.

Risks:

- Requires rebuilding crawler v2 schema and sample source state.
- More work than needed for `crawler_source_targets` verification.
- Risky unless all service migrations/seeds are complete and ordered.

Verdict: Good later if personal dev DB should become an integration environment. Too broad for current stage.

### E. Defer `crawler_source_targets` verification and keep org-unit mapping only in `parser_config.csv_metadata`

Pros:

- No DB changes.
- Existing `crawler_notice_sources.parser_config.csv_metadata.org_unit_id` preserves the intended mapping.

Risks:

- Does not validate the v2 source-target relationship.
- Leaves FK readiness unresolved.
- Blocks guarded apply design for `crawler_source_targets`.

Verdict: Safe but stalls P0-3.7. Use only if no DB prep is allowed.

## 9. Recommended Path

Recommended strategy: C.

Do not run Phase1 or Phase2 as-is. For P0-3.7, first run read-only schema and row-count checks. If the personal dev DB still contains only the minimal stub or an easily compatible stub, prepare a transaction-wrapped SQL patch that:

1. creates `public.org_unit_type` if missing.
2. adds Phase1-compatible columns to `public.org_units` if missing.
3. adds minimal indexes/constraints that do not conflict with existing data.
4. inserts only the 605 unique CSV `org_unit_id` values with explicit IDs.
5. uses provisional `name`, `unit_type`, `legacy_table = 'notice_sources_csv'`, and `legacy_id = org_unit_id`.
6. sets `path_ids = array[id]` for provisional parentless rows.
7. does not touch `profiles`, `scholarships`, `scholarship_target_units`, or `get_matched_scholarships`.

For the sample three sources:

- First validate only `cau_001`, `cau_002`, and `yonsei_060`.
- Then validate all 605 unique CSV IDs.
- Only after all source keys and org unit IDs are present should `crawler_source_targets` guarded apply be designed.

## 10. Proposed Read-only SQL

These queries are intended for inspection only.

```sql
-- Current org_units table shape.
select
  column_name,
  data_type,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'org_units'
order by ordinal_position;

-- Current constraints.
select
  conname,
  contype,
  pg_get_constraintdef(c.oid) as definition
from pg_constraint c
join pg_class t on t.oid = c.conrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public'
  and t.relname = 'org_units'
order by conname;

-- Current indexes.
select indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename = 'org_units'
order by indexname;

-- Current row count.
select count(*) as org_units_rows
from public.org_units;

-- Sample source readiness.
with required(source_key, org_unit_id) as (
  values
    ('cau_001', 719::bigint),
    ('cau_002', 720::bigint),
    ('yonsei_060', 46::bigint)
)
select
  r.source_key,
  s.id as source_id,
  r.org_unit_id,
  ou.id as existing_org_unit_id,
  (s.id is not null) as source_exists,
  (ou.id is not null) as org_unit_exists
from required r
left join public.crawler_notice_sources s
  on s.source_key = r.source_key
left join public.org_units ou
  on ou.id = r.org_unit_id
order by r.source_key;
```

For the all-CSV check, generate a temporary `required_org_units(org_unit_id)` list from the 605 unique CSV IDs and use:

```sql
with required_org_units(org_unit_id) as (
  -- Paste generated CSV unique IDs here for manual review.
  -- Example:
  values (46::bigint), (719::bigint), (720::bigint)
)
select
  count(*) as required_count,
  count(ou.id) as existing_count,
  count(*) - count(ou.id) as missing_count
from required_org_units r
left join public.org_units ou
  on ou.id = r.org_unit_id;
```

## 11. Proposed Preparation SQL Draft

Draft only. Do not execute until read-only checks confirm the stub shape and the generated CSV ID list has been reviewed.

```sql
begin;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'org_unit_type') then
    create type public.org_unit_type as enum
      ('university', 'college', 'division', 'department');
  end if;
end $$;

alter table public.org_units
  add column if not exists parent_id bigint null references public.org_units(id) on delete restrict,
  add column if not exists unit_type public.org_unit_type null,
  add column if not exists name text null,
  add column if not exists path_ids bigint[] not null default '{}',
  add column if not exists field_code text null,
  add column if not exists legacy_table text null,
  add column if not exists legacy_id bigint null,
  add column if not exists created_at timestamptz not null default now();

-- Keep provisional rows identifiable for rollback and future adoption.
create unique index if not exists uq_org_units_legacy
  on public.org_units (legacy_table, legacy_id)
  where legacy_table is not null;

create index if not exists idx_org_units_parent_id
  on public.org_units (parent_id);

create index if not exists idx_org_units_path_ids
  on public.org_units using gin (path_ids);

-- Insert generated CSV unique IDs here. Do not commit a full generated payload to the repo.
with csv_seed(id, unit_type, name) as (
  values
    (46::bigint, 'college'::public.org_unit_type, '언더우드국제대학'),
    (719::bigint, 'department'::public.org_unit_type, '중앙대 경영학부'),
    (720::bigint, 'department'::public.org_unit_type, '중앙대 경제학부')
)
insert into public.org_units (
  id,
  parent_id,
  unit_type,
  name,
  path_ids,
  legacy_table,
  legacy_id
)
overriding system value
select
  id,
  null,
  unit_type,
  name,
  array[id],
  'notice_sources_csv',
  id
from csv_seed
on conflict (id) do update
set
  unit_type = coalesce(public.org_units.unit_type, excluded.unit_type),
  name = coalesce(public.org_units.name, excluded.name),
  path_ids = case
    when public.org_units.path_ids = '{}'::bigint[] then excluded.path_ids
    else public.org_units.path_ids
  end,
  legacy_table = coalesce(public.org_units.legacy_table, excluded.legacy_table),
  legacy_id = coalesce(public.org_units.legacy_id, excluded.legacy_id);

-- Review before commit.
select count(*) as csv_seed_rows
from public.org_units
where legacy_table = 'notice_sources_csv';

rollback;
-- Replace rollback with commit only after review.
```

Notes:

- `overriding system value` is included so the draft can work even if `id` later becomes an identity column.
- `unit_type` is nullable in the ALTER draft to avoid failing immediately on existing stub rows. A later full migration can backfill and enforce `not null`.
- A full 605-row `csv_seed` values list should be generated locally from the CSV for manual review, not committed into this documentation.

## 12. Proposed Verification SQL

After a future approved seed, verify sample and full coverage before any `crawler_source_targets` apply.

```sql
-- Sample source-target readiness.
with required(source_key, org_unit_id) as (
  values
    ('cau_001', 719::bigint),
    ('cau_002', 720::bigint),
    ('yonsei_060', 46::bigint)
)
select
  r.source_key,
  s.id as source_id,
  r.org_unit_id,
  (s.id is not null) as source_exists,
  (ou.id is not null) as org_unit_exists
from required r
left join public.crawler_notice_sources s
  on s.source_key = r.source_key
left join public.org_units ou
  on ou.id = r.org_unit_id
order by r.source_key;

-- Full CSV unique org-unit coverage.
with required_org_units(org_unit_id) as (
  -- Paste generated 605 unique IDs here.
  values (46::bigint), (719::bigint), (720::bigint)
)
select r.org_unit_id
from required_org_units r
left join public.org_units ou
  on ou.id = r.org_unit_id
where ou.id is null
order by r.org_unit_id;

-- FK preview for source-target rows.
with required(source_key, org_unit_id) as (
  -- Paste generated selected source_key/org_unit_id pairs here.
  values
    ('cau_001', 719::bigint),
    ('cau_002', 720::bigint),
    ('yonsei_060', 46::bigint)
)
select
  count(*) as candidate_rows,
  count(s.id) as source_ready_rows,
  count(ou.id) as org_unit_ready_rows,
  count(*) filter (where s.id is not null and ou.id is not null) as ready_rows
from required r
left join public.crawler_notice_sources s
  on s.source_key = r.source_key
left join public.org_units ou
  on ou.id = r.org_unit_id;
```

## 13. Proposed Rollback / Cleanup SQL

Rollback should delete only rows clearly marked as CSV provisional seed rows and only if no dependent rows exist.

```sql
begin;

-- Check dependents first.
select count(*) as dependent_crawler_source_targets
from public.crawler_source_targets cst
join public.org_units ou on ou.id = cst.org_unit_id
where ou.legacy_table = 'notice_sources_csv';

select count(*) as dependent_crawler_notice_targets
from public.crawler_notice_targets cnt
join public.org_units ou on ou.id = cnt.org_unit_id
where ou.legacy_table = 'notice_sources_csv';

-- Delete only if dependent counts are zero.
delete from public.org_units
where legacy_table = 'notice_sources_csv'
  and not exists (
    select 1
    from public.crawler_source_targets cst
    where cst.org_unit_id = public.org_units.id
  )
  and not exists (
    select 1
    from public.crawler_notice_targets cnt
    where cnt.org_unit_id = public.org_units.id
  );

rollback;
-- Replace rollback with commit only after reviewing affected row count.
```

If the current schema lacks `legacy_table`, use an external reviewed ID list instead of a marker:

```sql
with seeded_ids(id) as (
  -- Paste reviewed generated IDs here.
  values (46::bigint), (719::bigint), (720::bigint)
)
delete from public.org_units ou
using seeded_ids s
where ou.id = s.id
  and not exists (
    select 1 from public.crawler_source_targets cst where cst.org_unit_id = ou.id
  )
  and not exists (
    select 1 from public.crawler_notice_targets cnt where cnt.org_unit_id = ou.id
  );
```

## 14. Open Questions / Risks

- Does the personal dev DB have only `org_units(id bigint primary key)`, or have additional columns/constraints been added since the last check?
- Does the DB already contain any non-stub `org_units` rows that should be preserved?
- Are CSV `org_unit_id` values intended to match a prior production `org_units.id` allocation exactly, or are they a crawler-local mapping snapshot?
- Can future Phase1 adoption use `legacy_table = 'notice_sources_csv'` rows, or should these be treated as disposable test seed only?
- Should `unit_type` for rows with `source_level=college` but department-like `department_name` be inferred from CSV `source_level`, from metadata presence, or left as a provisional default?
- Full hierarchy cannot be reconstructed from CSV alone. Parent-child matching and `path_ids` semantics should be considered provisional until service schema restoration.

## 15. Go / No-Go Criteria for P0-3.7

Go for P0-3.7 preparation only if all are true:

- Read-only schema check confirms `org_units` can be safely altered or is still the minimal stub.
- Existing `org_units` rows are either empty or understood.
- `crawler_notice_sources` contains the intended source keys.
- A generated CSV seed list contains exactly 605 unique positive IDs.
- The SQL draft is transaction-wrapped and first run with `rollback`.
- No Phase1/Phase2 SQL is run as-is.
- No `crawler_source_targets` insert/update is attempted until sample and full FK readiness checks pass.

No-go if any are true:

- `org_units` has unknown production-like data that could be overwritten.
- Full service tables/functions are missing but Phase1/Phase2 is being considered as-is.
- The generated seed list is not reviewed.
- Any required source key is missing from `crawler_notice_sources`.
- Any required `org_unit_id` remains missing after approved seed.
