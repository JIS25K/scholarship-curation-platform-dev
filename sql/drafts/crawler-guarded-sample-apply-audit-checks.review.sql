-- REVIEW ONLY - READ-ONLY SELECT CHECKS.
-- Guarded crawler controlled sample audit trail verification draft.
-- Production/main Supabase execution is prohibited.
--
-- Purpose:
--   Verify that the user-run personal-dev controlled sample apply preserved
--   run, source, notice, occurrence, target, alias, asset, error, and keyword
--   provenance before any cleanup or real crawler-output ingest gate.
--
-- Codex must not execute this SQL. The user may run it manually in a
-- confirmed personal dev database.

-- Phase 2 retry reference values confirmed by the user:
--   run_id = f14548e7-7bc2-4244-94b5-69b431aa67f7
--   rehearsal_label = controlled-sample-phase2-retry-20260709
--   source_key = yonsei_060
--   canonical_key = yonsei_060:url:e74c29f4562cf52025d9
--   expected_org_unit_id = 46

-- 1. Expected fixture identifiers.
with params as (
  select
    'f14548e7-7bc2-4244-94b5-69b431aa67f7'::uuid as run_id,
    'controlled-sample-phase2-retry-20260709'::text as rehearsal_label,
    'yonsei_060'::text as source_key,
    'yonsei_060:url:e74c29f4562cf52025d9'::text as canonical_key,
    46::bigint as org_unit_id
)
select * from params;

-- 2. Row-count summary. Expected count is 1 for every table below.
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
  select distinct n.id
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
select 'crawler_runs' as table_name, count(*) as actual_count, 1 as expected_count
from scoped_run
union all
select 'crawler_source_results', count(*), 1
from public.crawler_source_results sr
join scoped_run r on r.id = sr.run_id
join scoped_source s on s.id = sr.source_id
union all
select 'crawler_notices', count(*), 1
from scoped_notices
union all
select 'crawler_notice_url_aliases', count(*), 1
from public.crawler_notice_url_aliases ua
join scoped_notices n on n.id = ua.notice_id
join scoped_source s on s.id = ua.source_id
union all
select 'crawler_notice_occurrences', count(*), 1
from scoped_occurrences
union all
select 'crawler_notice_targets', count(*), 1
from public.crawler_notice_targets nt
join scoped_notices n on n.id = nt.notice_id
join params p on p.org_unit_id = nt.org_unit_id
union all
select 'crawler_notice_assets', count(*), 1
from public.crawler_notice_assets a
join scoped_notices n on n.id = a.notice_id
where exists (
  select 1 from scoped_occurrences o where o.id = a.occurrence_id
)
union all
select 'crawler_errors', count(*), 1
from public.crawler_errors e
join scoped_run r on r.id = e.run_id
join scoped_source s on s.id = e.source_id
join scoped_notices n on n.id = e.notice_id
union all
select 'crawler_keyword_matches', count(*), 1
from public.crawler_keyword_matches km
join scoped_notices n on n.id = km.notice_id
order by table_name;

-- 3. Run identity and metadata.
with params as (
  select
    'f14548e7-7bc2-4244-94b5-69b431aa67f7'::uuid as run_id,
    'controlled-sample-phase2-retry-20260709'::text as rehearsal_label
)
select
  r.id,
  r.started_at,
  r.ended_at,
  r.mode,
  r.status,
  r.metadata
from public.crawler_runs r
join params p on p.run_id = r.id
where r.metadata->>'rehearsal_label' = p.rehearsal_label;

-- 4. Source result linkage to the exact run and source.
with params as (
  select
    'f14548e7-7bc2-4244-94b5-69b431aa67f7'::uuid as run_id,
    'yonsei_060'::text as source_key
)
select
  sr.run_id,
  s.source_key,
  sr.decision,
  sr.counts,
  sr.error_count,
  sr.primary_failure_code,
  sr.metadata
from public.crawler_source_results sr
join public.crawler_notice_sources s on s.id = sr.source_id
join params p on p.run_id = sr.run_id and p.source_key = s.source_key
order by s.source_key;

-- 5. Occurrence provenance and notice linkage.
with params as (
  select
    'f14548e7-7bc2-4244-94b5-69b431aa67f7'::uuid as run_id,
    'yonsei_060'::text as source_key,
    'yonsei_060:url:e74c29f4562cf52025d9'::text as canonical_key
)
select
  o.id as occurrence_id,
  o.crawl_run_id,
  s.source_key,
  n.id as notice_id,
  n.canonical_key,
  o.discovered_url,
  o.final_url,
  o.list_title,
  o.list_posted_at,
  o.content_hash,
  o.created_at,
  o.updated_at
from public.crawler_notice_occurrences o
join public.crawler_notice_sources s on s.id = o.source_id
join public.crawler_notices n on n.id = o.notice_id
join params p on p.run_id = o.crawl_run_id
  and p.source_key = s.source_key
  and p.canonical_key = n.canonical_key
order by s.source_key, n.canonical_key;

-- 6. Target linkage to the expected org unit.
with params as (
  select
    'f14548e7-7bc2-4244-94b5-69b431aa67f7'::uuid as run_id,
    'yonsei_060:url:e74c29f4562cf52025d9'::text as canonical_key,
    46::bigint as org_unit_id
)
select
  n.canonical_key,
  nt.org_unit_id,
  nt.confidence,
  nt.evidence
from public.crawler_notice_targets nt
join public.crawler_notices n on n.id = nt.notice_id
join params p on p.canonical_key = n.canonical_key
  and p.org_unit_id = nt.org_unit_id
where exists (
  select 1
  from public.crawler_notice_occurrences o
  where o.notice_id = n.id
    and o.crawl_run_id = p.run_id
)
order by n.canonical_key;

-- 7. Child evidence rows linked back to the controlled notice/run.
with params as (
  select
    'f14548e7-7bc2-4244-94b5-69b431aa67f7'::uuid as run_id,
    'yonsei_060'::text as source_key,
    'yonsei_060:url:e74c29f4562cf52025d9'::text as canonical_key
),
scoped_notice as (
  select n.id
  from public.crawler_notices n
  join params p on p.canonical_key = n.canonical_key
),
scoped_source as (
  select s.id
  from public.crawler_notice_sources s
  join params p on p.source_key = s.source_key
),
scoped_occurrence as (
  select o.id, o.notice_id
  from public.crawler_notice_occurrences o
  join scoped_notice n on n.id = o.notice_id
  join scoped_source s on s.id = o.source_id
  join params p on p.run_id = o.crawl_run_id
)
select 'alias' as evidence_type, ua.notice_id, ua.source_id, ua.url as evidence_value
from public.crawler_notice_url_aliases ua
join scoped_notice n on n.id = ua.notice_id
join scoped_source s on s.id = ua.source_id
union all
select 'asset', a.notice_id, null::bigint, a.source_url
from public.crawler_notice_assets a
join scoped_notice n on n.id = a.notice_id
join scoped_occurrence o on o.id = a.occurrence_id
union all
select 'error', e.notice_id, e.source_id, e.error_class
from public.crawler_errors e
join scoped_notice n on n.id = e.notice_id
join scoped_source s on s.id = e.source_id
join params p on p.run_id = e.run_id
union all
select 'keyword', km.notice_id, null::bigint, km.keyword
from public.crawler_keyword_matches km
join scoped_notice n on n.id = km.notice_id
order by evidence_type, evidence_value;

-- 8. Orphan checks should all return zero.
with params as (
  select
    'f14548e7-7bc2-4244-94b5-69b431aa67f7'::uuid as run_id,
    'yonsei_060:url:e74c29f4562cf52025d9'::text as canonical_key
),
scoped_notice as (
  select n.id
  from public.crawler_notices n
  join params p on p.canonical_key = n.canonical_key
)
select 'occurrence_without_notice' as check_name, count(*) as orphan_count
from public.crawler_notice_occurrences o
left join public.crawler_notices n on n.id = o.notice_id
join params p on p.run_id = o.crawl_run_id
where n.id is null
union all
select 'target_without_scoped_notice', count(*)
from public.crawler_notice_targets nt
left join scoped_notice n on n.id = nt.notice_id
where nt.notice_id in (select id from scoped_notice) and n.id is null
union all
select 'asset_without_scoped_notice', count(*)
from public.crawler_notice_assets a
left join scoped_notice n on n.id = a.notice_id
where a.notice_id in (select id from scoped_notice) and n.id is null
union all
select 'alias_without_scoped_notice', count(*)
from public.crawler_notice_url_aliases ua
left join scoped_notice n on n.id = ua.notice_id
where ua.notice_id in (select id from scoped_notice) and n.id is null
union all
select 'keyword_without_scoped_notice', count(*)
from public.crawler_keyword_matches km
left join scoped_notice n on n.id = km.notice_id
where km.notice_id in (select id from scoped_notice) and n.id is null;

-- 9. Timestamp sanity for rows created during the reviewed rehearsal window.
with params as (
  select
    'f14548e7-7bc2-4244-94b5-69b431aa67f7'::uuid as run_id,
    'yonsei_060:url:e74c29f4562cf52025d9'::text as canonical_key
)
select
  n.canonical_key,
  n.created_at,
  n.updated_at,
  min(o.created_at) as first_occurrence_created_at,
  max(o.updated_at) as last_occurrence_updated_at
from public.crawler_notices n
join public.crawler_notice_occurrences o on o.notice_id = n.id
join params p on p.canonical_key = n.canonical_key and p.run_id = o.crawl_run_id
group by n.id, n.canonical_key, n.created_at, n.updated_at
order by n.canonical_key;
