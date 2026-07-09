-- REVIEW ONLY - READ-ONLY SELECT CHECKS.
-- Guarded crawler sample apply audit trail verification draft.
-- Production/main Supabase execution is prohibited.
--
-- Purpose:
--   Verify that a future personal-dev guarded sample apply preserved run,
--   source, occurrence, target, alias, asset, error, and keyword provenance.
--
-- Replace these placeholders manually during a reviewed personal-dev audit:
--   :'rehearsal_run_id'
--   :'rehearsal_label'
--   :'expected_source_key'
--   :'expected_org_unit_id'

-- 1. Run identity and metadata.
select
  id,
  started_at,
  ended_at,
  mode,
  status,
  metadata
from public.crawler_runs
where id = :'rehearsal_run_id'::uuid
   or metadata->>'rehearsal_label' = :'rehearsal_label';

-- 2. Source result linkage to the run.
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
where sr.run_id = :'rehearsal_run_id'::uuid
  and s.source_key = :'expected_source_key'
order by s.source_key;

-- 3. Occurrence provenance and notice linkage.
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
where o.crawl_run_id = :'rehearsal_run_id'::uuid
order by s.source_key, n.canonical_key;

-- 4. Target linkage to expected org unit.
select
  n.canonical_key,
  nt.org_unit_id,
  nt.confidence,
  nt.evidence
from public.crawler_notice_targets nt
join public.crawler_notices n on n.id = nt.notice_id
where nt.org_unit_id = :'expected_org_unit_id'::bigint
  and exists (
    select 1
    from public.crawler_notice_occurrences o
    where o.notice_id = n.id
      and o.crawl_run_id = :'rehearsal_run_id'::uuid
  )
order by n.canonical_key;

-- 5. URL aliases connected to rehearsal notices.
select
  n.canonical_key,
  s.source_key,
  ua.url,
  ua.first_seen_at,
  ua.last_seen_at
from public.crawler_notice_url_aliases ua
join public.crawler_notices n on n.id = ua.notice_id
left join public.crawler_notice_sources s on s.id = ua.source_id
where exists (
  select 1
  from public.crawler_notice_occurrences o
  where o.notice_id = n.id
    and o.crawl_run_id = :'rehearsal_run_id'::uuid
)
order by n.canonical_key, ua.url;

-- 6. Asset references connected to rehearsal notices.
select
  n.canonical_key,
  a.asset_kind,
  a.source_url,
  a.filename,
  a.mime,
  a.status
from public.crawler_notice_assets a
join public.crawler_notices n on n.id = a.notice_id
where exists (
  select 1
  from public.crawler_notice_occurrences o
  where o.notice_id = n.id
    and o.crawl_run_id = :'rehearsal_run_id'::uuid
)
order by n.canonical_key, a.asset_kind, a.source_url;

-- 7. Warnings/errors preserved for audit.
select
  e.run_id,
  s.source_key,
  n.canonical_key,
  e.stage,
  e.error_class,
  e.http_status,
  e.message,
  e.details,
  e.created_at
from public.crawler_errors e
left join public.crawler_notice_sources s on s.id = e.source_id
left join public.crawler_notices n on n.id = e.notice_id
where e.run_id = :'rehearsal_run_id'::uuid
order by e.created_at, s.source_key;

-- 8. Keyword evidence connected to rehearsal notices.
select
  n.canonical_key,
  km.keyword,
  km.field,
  km.offset_start,
  km.offset_end,
  km.score
from public.crawler_keyword_matches km
join public.crawler_notices n on n.id = km.notice_id
where exists (
  select 1
  from public.crawler_notice_occurrences o
  where o.notice_id = n.id
    and o.crawl_run_id = :'rehearsal_run_id'::uuid
)
order by n.canonical_key, km.keyword;

-- 9. Orphan checks should all return zero rows.
select 'occurrence_without_notice' as check_name, count(*) as orphan_count
from public.crawler_notice_occurrences o
left join public.crawler_notices n on n.id = o.notice_id
where o.crawl_run_id = :'rehearsal_run_id'::uuid
  and n.id is null
union all
select 'target_without_notice', count(*)
from public.crawler_notice_targets nt
left join public.crawler_notices n on n.id = nt.notice_id
where n.id is null
union all
select 'asset_without_notice', count(*)
from public.crawler_notice_assets a
left join public.crawler_notices n on n.id = a.notice_id
where n.id is null
union all
select 'alias_without_notice', count(*)
from public.crawler_notice_url_aliases ua
left join public.crawler_notices n on n.id = ua.notice_id
where n.id is null;

-- 10. Timestamp sanity for rows created during the reviewed rehearsal window.
select
  n.canonical_key,
  n.created_at,
  n.updated_at,
  min(o.created_at) as first_occurrence_created_at,
  max(o.updated_at) as last_occurrence_updated_at
from public.crawler_notices n
join public.crawler_notice_occurrences o on o.notice_id = n.id
where o.crawl_run_id = :'rehearsal_run_id'::uuid
group by n.id, n.canonical_key, n.created_at, n.updated_at
order by n.canonical_key;
