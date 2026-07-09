-- REVIEW ONLY - DO NOT RUN AUTOMATICALLY.
-- Guarded crawler controlled sample cleanup draft.
-- Production/main Supabase execution is prohibited.
--
-- Purpose:
--   Preview and, only after manual approval, clean up the exact personal-dev
--   controlled fixture row set from the Phase 2 retry.
--
-- Safety rules:
--   1. Personal dev only. Never use this against production/main Supabase.
--   2. Codex must not execute this SQL.
--   3. The scope is the exact Phase 2 retry fixture: run_id, rehearsal_label,
--      source_key, and canonical_key. Do not broaden to source_key alone.
--   4. Run the pre-cleanup count section first and compare it with the audit.
--   5. Keep the final transaction ending as ROLLBACK during review.
--   6. Change ROLLBACK to COMMIT only after explicit manual approval.
--
-- Phase 2 retry reference values confirmed by the user:
--   run_id = f14548e7-7bc2-4244-94b5-69b431aa67f7
--   rehearsal_label = controlled-sample-phase2-retry-20260709
--   source_key = yonsei_060
--   canonical_key = yonsei_060:url:e74c29f4562cf52025d9
--   expected_org_unit_id = 46

begin;

-- 1. Pre-cleanup scoped counts. Expected before cleanup: every count is 1.
with params as (
  select
    'f14548e7-7bc2-4244-94b5-69b431aa67f7'::uuid as run_id,
    'controlled-sample-phase2-retry-20260709'::text as rehearsal_label,
    'yonsei_060'::text as source_key,
    'yonsei_060:url:e74c29f4562cf52025d9'::text as canonical_key,
    46::bigint as org_unit_id
),
scoped_run as (
  select r.id
  from public.crawler_runs r
  join params p on p.run_id = r.id
  where r.metadata->>'rehearsal_label' = p.rehearsal_label
),
scoped_source as (
  select s.id
  from public.crawler_notice_sources s
  join params p on p.source_key = s.source_key
),
scoped_notices as (
  select n.id
  from public.crawler_notices n
  join params p on p.canonical_key = n.canonical_key
  where n.metadata->>'rehearsal_label' = p.rehearsal_label
     or n.metadata->>'controlled_sample' = 'true'
),
scoped_occurrences as (
  select o.id, o.notice_id
  from public.crawler_notice_occurrences o
  join scoped_run r on r.id = o.crawl_run_id
  join scoped_source s on s.id = o.source_id
  join scoped_notices n on n.id = o.notice_id
)
select 'before:crawler_runs' as table_name, count(*) as scoped_count
from scoped_run
union all
select 'before:crawler_source_results', count(*)
from public.crawler_source_results sr
join scoped_run r on r.id = sr.run_id
join scoped_source s on s.id = sr.source_id
union all
select 'before:crawler_notices', count(*)
from scoped_notices
union all
select 'before:crawler_notice_url_aliases', count(*)
from public.crawler_notice_url_aliases ua
join scoped_notices n on n.id = ua.notice_id
join scoped_source s on s.id = ua.source_id
union all
select 'before:crawler_notice_occurrences', count(*)
from scoped_occurrences
union all
select 'before:crawler_notice_targets', count(*)
from public.crawler_notice_targets nt
join scoped_notices n on n.id = nt.notice_id
join params p on p.org_unit_id = nt.org_unit_id
union all
select 'before:crawler_notice_assets', count(*)
from public.crawler_notice_assets a
join scoped_notices n on n.id = a.notice_id
union all
select 'before:crawler_errors', count(*)
from public.crawler_errors e
join scoped_run r on r.id = e.run_id
join scoped_source s on s.id = e.source_id
join scoped_notices n on n.id = e.notice_id
union all
select 'before:crawler_keyword_matches', count(*)
from public.crawler_keyword_matches km
join scoped_notices n on n.id = km.notice_id
order by table_name;

-- 2. FK-safe cleanup order.
--    Review counts above before allowing this block to commit.

-- 2.1 crawler_keyword_matches
with params as (
  select
    'controlled-sample-phase2-retry-20260709'::text as rehearsal_label,
    'yonsei_060:url:e74c29f4562cf52025d9'::text as canonical_key
),
scoped_notices as (
  select n.id
  from public.crawler_notices n
  join params p on p.canonical_key = n.canonical_key
  where n.metadata->>'rehearsal_label' = p.rehearsal_label
     or n.metadata->>'controlled_sample' = 'true'
)
delete from public.crawler_keyword_matches km
using scoped_notices n
where km.notice_id = n.id;

-- 2.2 crawler_errors
with params as (
  select
    'f14548e7-7bc2-4244-94b5-69b431aa67f7'::uuid as run_id,
    'controlled-sample-phase2-retry-20260709'::text as rehearsal_label,
    'yonsei_060'::text as source_key,
    'yonsei_060:url:e74c29f4562cf52025d9'::text as canonical_key
),
scoped_run as (
  select r.id
  from public.crawler_runs r
  join params p on p.run_id = r.id
  where r.metadata->>'rehearsal_label' = p.rehearsal_label
),
scoped_source as (
  select s.id
  from public.crawler_notice_sources s
  join params p on p.source_key = s.source_key
),
scoped_notices as (
  select n.id
  from public.crawler_notices n
  join params p on p.canonical_key = n.canonical_key
  where n.metadata->>'rehearsal_label' = p.rehearsal_label
     or n.metadata->>'controlled_sample' = 'true'
)
delete from public.crawler_errors e
using scoped_run r, scoped_source s, scoped_notices n
where e.run_id = r.id
  and e.source_id = s.id
  and e.notice_id = n.id;

-- 2.3 crawler_notice_assets
with params as (
  select
    'f14548e7-7bc2-4244-94b5-69b431aa67f7'::uuid as run_id,
    'controlled-sample-phase2-retry-20260709'::text as rehearsal_label,
    'yonsei_060'::text as source_key,
    'yonsei_060:url:e74c29f4562cf52025d9'::text as canonical_key
),
scoped_run as (
  select r.id
  from public.crawler_runs r
  join params p on p.run_id = r.id
  where r.metadata->>'rehearsal_label' = p.rehearsal_label
),
scoped_source as (
  select s.id
  from public.crawler_notice_sources s
  join params p on p.source_key = s.source_key
),
scoped_notices as (
  select n.id
  from public.crawler_notices n
  join params p on p.canonical_key = n.canonical_key
  where n.metadata->>'rehearsal_label' = p.rehearsal_label
     or n.metadata->>'controlled_sample' = 'true'
),
scoped_occurrences as (
  select o.id
  from public.crawler_notice_occurrences o
  join scoped_run r on r.id = o.crawl_run_id
  join scoped_source s on s.id = o.source_id
  join scoped_notices n on n.id = o.notice_id
)
delete from public.crawler_notice_assets a
using scoped_notices n
where a.notice_id = n.id;

-- 2.4 crawler_notice_targets
with params as (
  select
    'controlled-sample-phase2-retry-20260709'::text as rehearsal_label,
    'yonsei_060:url:e74c29f4562cf52025d9'::text as canonical_key,
    46::bigint as org_unit_id
),
scoped_notices as (
  select n.id
  from public.crawler_notices n
  join params p on p.canonical_key = n.canonical_key
  where n.metadata->>'rehearsal_label' = p.rehearsal_label
     or n.metadata->>'controlled_sample' = 'true'
)
delete from public.crawler_notice_targets nt
using scoped_notices n, params p
where nt.notice_id = n.id
  and nt.org_unit_id = p.org_unit_id;

-- 2.5 crawler_notice_url_aliases
with params as (
  select
    'controlled-sample-phase2-retry-20260709'::text as rehearsal_label,
    'yonsei_060'::text as source_key,
    'yonsei_060:url:e74c29f4562cf52025d9'::text as canonical_key
),
scoped_source as (
  select s.id
  from public.crawler_notice_sources s
  join params p on p.source_key = s.source_key
),
scoped_notices as (
  select n.id
  from public.crawler_notices n
  join params p on p.canonical_key = n.canonical_key
  where n.metadata->>'rehearsal_label' = p.rehearsal_label
     or n.metadata->>'controlled_sample' = 'true'
)
delete from public.crawler_notice_url_aliases ua
using scoped_notices n, scoped_source s
where ua.notice_id = n.id
  and ua.source_id = s.id;

-- 2.6 crawler_notice_occurrences
with params as (
  select
    'f14548e7-7bc2-4244-94b5-69b431aa67f7'::uuid as run_id,
    'controlled-sample-phase2-retry-20260709'::text as rehearsal_label,
    'yonsei_060'::text as source_key,
    'yonsei_060:url:e74c29f4562cf52025d9'::text as canonical_key
),
scoped_run as (
  select r.id
  from public.crawler_runs r
  join params p on p.run_id = r.id
  where r.metadata->>'rehearsal_label' = p.rehearsal_label
),
scoped_source as (
  select s.id
  from public.crawler_notice_sources s
  join params p on p.source_key = s.source_key
),
scoped_notices as (
  select n.id
  from public.crawler_notices n
  join params p on p.canonical_key = n.canonical_key
  where n.metadata->>'rehearsal_label' = p.rehearsal_label
     or n.metadata->>'controlled_sample' = 'true'
)
delete from public.crawler_notice_occurrences o
using scoped_run r, scoped_source s, scoped_notices n
where o.crawl_run_id = r.id
  and o.source_id = s.id
  and o.notice_id = n.id;

-- 2.7 crawler_source_results
with params as (
  select
    'f14548e7-7bc2-4244-94b5-69b431aa67f7'::uuid as run_id,
    'controlled-sample-phase2-retry-20260709'::text as rehearsal_label,
    'yonsei_060'::text as source_key
),
scoped_run as (
  select r.id
  from public.crawler_runs r
  join params p on p.run_id = r.id
  where r.metadata->>'rehearsal_label' = p.rehearsal_label
),
scoped_source as (
  select s.id
  from public.crawler_notice_sources s
  join params p on p.source_key = s.source_key
)
delete from public.crawler_source_results sr
using scoped_run r, scoped_source s
where sr.run_id = r.id
  and sr.source_id = s.id;

-- 2.8 crawler_notices
with params as (
  select
    'controlled-sample-phase2-retry-20260709'::text as rehearsal_label,
    'yonsei_060:url:e74c29f4562cf52025d9'::text as canonical_key
)
delete from public.crawler_notices n
using params p
where n.canonical_key = p.canonical_key
  and (
    n.metadata->>'rehearsal_label' = p.rehearsal_label
    or n.metadata->>'controlled_sample' = 'true'
  );

-- 2.9 crawler_runs
with params as (
  select
    'f14548e7-7bc2-4244-94b5-69b431aa67f7'::uuid as run_id,
    'controlled-sample-phase2-retry-20260709'::text as rehearsal_label
)
delete from public.crawler_runs r
using params p
where r.id = p.run_id
  and r.metadata->>'rehearsal_label' = p.rehearsal_label;

-- 3. Post-cleanup scoped counts. Expected after the delete block: all zeros.
--    If the user keeps ROLLBACK below, these zeros are only transaction-local.
--    After an approved COMMIT, rerun this section separately to verify cleanup.
with params as (
  select
    'f14548e7-7bc2-4244-94b5-69b431aa67f7'::uuid as run_id,
    'controlled-sample-phase2-retry-20260709'::text as rehearsal_label,
    'yonsei_060'::text as source_key,
    'yonsei_060:url:e74c29f4562cf52025d9'::text as canonical_key,
    46::bigint as org_unit_id
),
scoped_run as (
  select r.id
  from public.crawler_runs r
  join params p on p.run_id = r.id
  where r.metadata->>'rehearsal_label' = p.rehearsal_label
),
scoped_source as (
  select s.id
  from public.crawler_notice_sources s
  join params p on p.source_key = s.source_key
),
scoped_notices as (
  select n.id
  from public.crawler_notices n
  join params p on p.canonical_key = n.canonical_key
  where n.metadata->>'rehearsal_label' = p.rehearsal_label
     or n.metadata->>'controlled_sample' = 'true'
),
scoped_occurrences as (
  select o.id, o.notice_id
  from public.crawler_notice_occurrences o
  join scoped_run r on r.id = o.crawl_run_id
  join scoped_source s on s.id = o.source_id
  join scoped_notices n on n.id = o.notice_id
)
select 'after:crawler_runs' as table_name, count(*) as scoped_count
from scoped_run
union all
select 'after:crawler_source_results', count(*)
from public.crawler_source_results sr
join params p on p.run_id = sr.run_id
join scoped_source s on s.id = sr.source_id
union all
select 'after:crawler_notices', count(*)
from scoped_notices
union all
select 'after:crawler_notice_url_aliases', count(*)
from public.crawler_notice_url_aliases ua
join scoped_notices n on n.id = ua.notice_id
join scoped_source s on s.id = ua.source_id
union all
select 'after:crawler_notice_occurrences', count(*)
from scoped_occurrences
union all
select 'after:crawler_notice_targets', count(*)
from public.crawler_notice_targets nt
join scoped_notices n on n.id = nt.notice_id
join params p on p.org_unit_id = nt.org_unit_id
union all
select 'after:crawler_notice_assets', count(*)
from public.crawler_notice_assets a
join scoped_notices n on n.id = a.notice_id
union all
select 'after:crawler_errors', count(*)
from public.crawler_errors e
join params p on p.run_id = e.run_id
join scoped_source s on s.id = e.source_id
join scoped_notices n on n.id = e.notice_id
union all
select 'after:crawler_keyword_matches', count(*)
from public.crawler_keyword_matches km
join scoped_notices n on n.id = km.notice_id
order by table_name;

-- Default review behavior: do not persist anything.
rollback;

-- Replace the final ROLLBACK with COMMIT only after manual review, preview
-- count approval, and explicit personal-dev cleanup authorization.
