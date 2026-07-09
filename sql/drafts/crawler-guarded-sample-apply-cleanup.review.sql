-- REVIEW ONLY - DO NOT RUN AUTOMATICALLY.
-- Guarded crawler sample apply cleanup draft.
-- Production/main Supabase execution is prohibited.
--
-- Purpose:
--   Preview and clean up rows created by a future personal-dev guarded sample
--   apply rehearsal. This draft must be reviewed and parameterized with a
--   rehearsal run id or deterministic metadata label before any execution.
--
-- Safety rules:
--   1. Do not run without an explicit rehearsal run id or run label.
--   2. Run SELECT previews first and compare counts with the apply report.
--   3. Keep the default transaction ending as ROLLBACK during review.
--   4. Never use this against production/main Supabase.
--   5. Do not delete rows that cannot be tied to the rehearsal run/label.
--   6. For a successful controlled apply cleanup, delete child evidence first,
--      then source_results, notices, and finally crawler_runs.

begin;

-- Replace these placeholders manually during a reviewed personal-dev cleanup.
-- psql example:
--   \set rehearsal_run_id '00000000-0000-0000-0000-000000000000'
--   \set rehearsal_label 'crawler-guarded-sample-YYYYMMDD-HHMM'
--   \set expected_source_key 'yonsei_060'
--   \set expected_canonical_key 'yonsei_060:url:e74c29f4562cf52025d9'

-- 1. Identify the exact rehearsal run.
with rehearsal_run as (
  select id
  from public.crawler_runs
  where id = :'rehearsal_run_id'::uuid
     or metadata->>'rehearsal_label' = :'rehearsal_label'
)
select 'crawler_runs' as table_name, count(*) as rows_to_review
from rehearsal_run;

-- 2. Preview dependent rows before any delete.
with rehearsal_run as (
  select id
  from public.crawler_runs
  where id = :'rehearsal_run_id'::uuid
     or metadata->>'rehearsal_label' = :'rehearsal_label'
),
occurrences as (
  select o.id, o.notice_id
  from public.crawler_notice_occurrences o
  join rehearsal_run r on r.id = o.crawl_run_id
),
notices as (
  select distinct n.id
  from public.crawler_notices n
  left join occurrences o on o.notice_id = n.id
  where n.metadata->>'rehearsal_label' = :'rehearsal_label'
     or (
       n.canonical_key = :'expected_canonical_key'
       and n.metadata->>'controlled_sample' = 'true'
     )
     or o.notice_id is not null
)
select 'crawler_source_results' as table_name, count(*) from public.crawler_source_results sr join rehearsal_run r on r.id = sr.run_id
union all
select 'crawler_notice_occurrences', count(*) from occurrences
union all
select 'crawler_errors', count(*) from public.crawler_errors e join rehearsal_run r on r.id = e.run_id
union all
select 'crawler_keyword_matches', count(*) from public.crawler_keyword_matches km join notices n on n.id = km.notice_id
union all
select 'crawler_notice_targets', count(*) from public.crawler_notice_targets nt join notices n on n.id = nt.notice_id
union all
select 'crawler_notice_assets', count(*) from public.crawler_notice_assets a join notices n on n.id = a.notice_id
union all
select 'crawler_notice_url_aliases', count(*) from public.crawler_notice_url_aliases ua join notices n on n.id = ua.notice_id
union all
select 'crawler_notices', count(*) from notices;

-- 3. Cleanup order follows FK dependencies. Keep commented until reviewed.
-- Successful apply cleanup order:
--   1. crawler_keyword_matches
--   2. crawler_notice_assets
--   3. crawler_notice_targets
--   4. crawler_notice_url_aliases
--   5. crawler_errors
--   6. crawler_notice_occurrences
--   7. crawler_source_results
--   8. crawler_notices scoped by rehearsal label/canonical key
--   9. crawler_runs
-- with rehearsal_run as (
--   select id
--   from public.crawler_runs
--   where id = :'rehearsal_run_id'::uuid
--      or metadata->>'rehearsal_label' = :'rehearsal_label'
-- ),
-- occurrences as (
--   select o.id, o.notice_id
--   from public.crawler_notice_occurrences o
--   join rehearsal_run r on r.id = o.crawl_run_id
-- ),
-- notices as (
--   select distinct n.id
--   from public.crawler_notices n
--   left join occurrences o on o.notice_id = n.id
--   where n.metadata->>'rehearsal_label' = :'rehearsal_label'
--      or (
--        n.canonical_key = :'expected_canonical_key'
--        and n.metadata->>'controlled_sample' = 'true'
--      )
--      or o.notice_id is not null
-- )
-- delete from public.crawler_keyword_matches km using notices n where km.notice_id = n.id;
-- delete from public.crawler_notice_assets a using notices n where a.notice_id = n.id;
-- delete from public.crawler_notice_targets nt using notices n where nt.notice_id = n.id;
-- delete from public.crawler_notice_url_aliases ua using notices n where ua.notice_id = n.id;
-- delete from public.crawler_errors e using rehearsal_run r where e.run_id = r.id;
-- delete from public.crawler_notice_occurrences o using rehearsal_run r where o.crawl_run_id = r.id;
-- delete from public.crawler_source_results sr using rehearsal_run r where sr.run_id = r.id;
-- delete from public.crawler_notices n using notices scoped where n.id = scoped.id;
-- delete from public.crawler_runs r using rehearsal_run scoped where r.id = scoped.id;

-- Default review behavior: do not persist anything.
rollback;

-- Replace the final ROLLBACK with COMMIT only after manual review, preview count
-- approval, and explicit personal-dev cleanup authorization.
