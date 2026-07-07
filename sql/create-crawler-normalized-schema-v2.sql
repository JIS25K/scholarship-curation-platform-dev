-- Crawler normalized schema v2
--
-- Purpose:
--   Preserve source provenance, canonical notice identity, discovery paths,
--   org-unit targets, assets, run history, audit evidence, and crawler errors
--   separately. This schema is additive: it does not drop or rewrite the
--   existing crawled_notices staging table.
--
-- Execution:
--   Run in Supabase SQL Editor. The migration is idempotent for tables,
--   indexes, triggers, and policies.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- 1. Source registry -------------------------------------------------------

create table if not exists public.crawler_notice_sources (
  id bigint generated always as identity primary key,
  source_key text not null,
  university_slug text null,
  source_level text not null default 'department',
  source_name text not null,
  configured_url text not null,
  effective_url text null,
  base_url text null,
  parser_config jsonb not null default '{}'::jsonb,
  adapter_code text null,
  enabled boolean not null default true,
  health jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crawler_notice_sources_source_key_unique unique (source_key),
  constraint crawler_notice_sources_source_level_check
    check (source_level in ('university', 'college', 'division', 'department'))
);

comment on table public.crawler_notice_sources is
  'Canonical crawler source registry. One row per enabled notice source from data/notice-sources.csv.';
comment on column public.crawler_notice_sources.parser_config is
  'Selectors, URL patterns, keywords, detail access hints, and other parser configuration.';
comment on column public.crawler_notice_sources.health is
  'Latest operational health summary for this source. Historical health belongs in crawler_source_results.';

create index if not exists idx_crawler_notice_sources_university_slug
  on public.crawler_notice_sources (university_slug);
create index if not exists idx_crawler_notice_sources_enabled
  on public.crawler_notice_sources (enabled);
create index if not exists idx_crawler_notice_sources_adapter_code
  on public.crawler_notice_sources (adapter_code) where adapter_code is not null;

drop trigger if exists trg_crawler_notice_sources_updated_at on public.crawler_notice_sources;
create trigger trg_crawler_notice_sources_updated_at
  before update on public.crawler_notice_sources
  for each row execute function public.set_updated_at();

create table if not exists public.crawler_source_targets (
  source_id bigint not null references public.crawler_notice_sources(id) on delete cascade,
  org_unit_id bigint not null references public.org_units(id) on delete restrict,
  priority smallint not null default 0,
  created_at timestamptz not null default now(),
  primary key (source_id, org_unit_id)
);

comment on table public.crawler_source_targets is
  'Many-to-many mapping between shared notice sources and the org_units they serve.';

create index if not exists idx_crawler_source_targets_org_unit_id
  on public.crawler_source_targets (org_unit_id);

-- 2. Canonical notice and provenance ---------------------------------------

create table if not exists public.crawler_notices (
  id bigint generated always as identity primary key,
  canonical_key text not null,
  canonical_url text null,
  native_post_id text null,
  title text not null,
  body_text text null,
  body_html text null,
  posted_at date null,
  content_hash text null,
  review_status text not null default 'new',
  scholarship_id bigint null references public.scholarships(id) on delete set null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  deleted_at timestamptz null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crawler_notices_canonical_key_unique unique (canonical_key),
  constraint crawler_notices_review_status_check
    check (review_status in ('new', 'promoted', 'rejected', 'ignored'))
);

comment on table public.crawler_notices is
  'Canonical notice record. URL is not treated as permanent identity; canonical_key and occurrence history preserve identity/provenance.';
comment on column public.crawler_notices.canonical_key is
  'Stable dedupe key produced by crawler/ingest, e.g. native id, URL hash, or normalized title+date+source policy.';
comment on column public.crawler_notices.content_hash is
  'Hash of normalized body/title/date content used for change detection.';

create index if not exists idx_crawler_notices_posted_at
  on public.crawler_notices (posted_at desc nulls last);
create index if not exists idx_crawler_notices_review_status
  on public.crawler_notices (review_status);
create index if not exists idx_crawler_notices_content_hash
  on public.crawler_notices (content_hash) where content_hash is not null;
create index if not exists idx_crawler_notices_scholarship_id
  on public.crawler_notices (scholarship_id) where scholarship_id is not null;
create index if not exists idx_crawler_notices_deleted_at
  on public.crawler_notices (deleted_at) where deleted_at is not null;

drop trigger if exists trg_crawler_notices_updated_at on public.crawler_notices;
create trigger trg_crawler_notices_updated_at
  before update on public.crawler_notices
  for each row execute function public.set_updated_at();

create table if not exists public.crawler_notice_url_aliases (
  id bigint generated always as identity primary key,
  notice_id bigint not null references public.crawler_notices(id) on delete cascade,
  source_id bigint null references public.crawler_notice_sources(id) on delete set null,
  url text not null,
  url_hash text generated always as (md5(url)) stored,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint crawler_notice_url_aliases_notice_url_unique unique (notice_id, url_hash)
);

comment on table public.crawler_notice_url_aliases is
  'Known URL aliases for a canonical notice. Used when institutions move or rewrite detail URLs.';

create index if not exists idx_crawler_notice_url_aliases_url_hash
  on public.crawler_notice_url_aliases (url_hash);
create index if not exists idx_crawler_notice_url_aliases_source_id
  on public.crawler_notice_url_aliases (source_id) where source_id is not null;

create table if not exists public.crawler_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  ended_at timestamptz null,
  mode text not null,
  git_sha text null,
  config_hash text null,
  parser_version text null,
  status text not null default 'running',
  totals jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint crawler_runs_mode_check
    check (mode in ('daily', 'baseline', 'audit', 'manual', 'backfill')),
  constraint crawler_runs_status_check
    check (status in ('running', 'succeeded', 'failed', 'partial', 'cancelled'))
);

comment on table public.crawler_runs is
  'One crawler or audit execution. Source-level details are stored in crawler_source_results and crawler_audit_results.';

create index if not exists idx_crawler_runs_started_at
  on public.crawler_runs (started_at desc);
create index if not exists idx_crawler_runs_mode_status
  on public.crawler_runs (mode, status);

create table if not exists public.crawler_notice_occurrences (
  id bigint generated always as identity primary key,
  notice_id bigint not null references public.crawler_notices(id) on delete cascade,
  source_id bigint not null references public.crawler_notice_sources(id) on delete restrict,
  crawl_run_id uuid null references public.crawler_runs(id) on delete set null,
  discovered_url text not null,
  discovered_url_hash text generated always as (md5(discovered_url)) stored,
  final_url text null,
  native_post_id text null,
  list_title text null,
  raw_list_text text null,
  list_posted_at date null,
  detail_fetched_at timestamptz null,
  content_hash text null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  deleted_at timestamptz null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crawler_notice_occurrences_source_url_unique unique (source_id, discovered_url_hash)
);

comment on table public.crawler_notice_occurrences is
  'Discovery path for a notice from a specific source and URL. Preserves shared-board provenance and URL history.';

create index if not exists idx_crawler_notice_occurrences_notice_id
  on public.crawler_notice_occurrences (notice_id);
create index if not exists idx_crawler_notice_occurrences_source_seen
  on public.crawler_notice_occurrences (source_id, last_seen_at desc);
create index if not exists idx_crawler_notice_occurrences_run_id
  on public.crawler_notice_occurrences (crawl_run_id) where crawl_run_id is not null;
create index if not exists idx_crawler_notice_occurrences_deleted_at
  on public.crawler_notice_occurrences (deleted_at) where deleted_at is not null;

drop trigger if exists trg_crawler_notice_occurrences_updated_at on public.crawler_notice_occurrences;
create trigger trg_crawler_notice_occurrences_updated_at
  before update on public.crawler_notice_occurrences
  for each row execute function public.set_updated_at();

create table if not exists public.crawler_notice_targets (
  notice_id bigint not null references public.crawler_notices(id) on delete cascade,
  org_unit_id bigint not null references public.org_units(id) on delete restrict,
  source_id bigint null references public.crawler_notice_sources(id) on delete set null,
  confidence numeric(5,4) not null default 1.0,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (notice_id, org_unit_id),
  constraint crawler_notice_targets_confidence_check
    check (confidence >= 0 and confidence <= 1)
);

comment on table public.crawler_notice_targets is
  'Many-to-many notice-to-org_unit targets. A notice can apply to multiple colleges/departments.';

create index if not exists idx_crawler_notice_targets_org_unit_id
  on public.crawler_notice_targets (org_unit_id);
create index if not exists idx_crawler_notice_targets_source_id
  on public.crawler_notice_targets (source_id) where source_id is not null;

-- 3. Assets and extracted evidence ----------------------------------------

create table if not exists public.crawler_notice_assets (
  id bigint generated always as identity primary key,
  notice_id bigint not null references public.crawler_notices(id) on delete cascade,
  occurrence_id bigint null references public.crawler_notice_occurrences(id) on delete set null,
  asset_kind text not null,
  source_url text not null,
  source_url_hash text generated always as (md5(source_url)) stored,
  storage_bucket text null,
  storage_key text null,
  filename text null,
  mime text null,
  sha256 text null,
  width integer null,
  height integer null,
  position integer null,
  alt text null,
  caption text null,
  extracted_text text null,
  status text not null default 'referenced',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crawler_notice_assets_kind_check
    check (asset_kind in ('image', 'attachment')),
  constraint crawler_notice_assets_status_check
    check (status in ('referenced', 'stored', 'extracted', 'failed', 'ignored')),
  constraint crawler_notice_assets_size_check
    check ((width is null or width >= 0) and (height is null or height >= 0)),
  constraint crawler_notice_assets_notice_kind_url_unique unique (notice_id, asset_kind, source_url_hash)
);

comment on table public.crawler_notice_assets is
  'Images and attachments referenced by a notice. URL extraction, file storage, and text/OCR extraction are tracked separately.';

create index if not exists idx_crawler_notice_assets_notice_id
  on public.crawler_notice_assets (notice_id);
create index if not exists idx_crawler_notice_assets_occurrence_id
  on public.crawler_notice_assets (occurrence_id) where occurrence_id is not null;
create index if not exists idx_crawler_notice_assets_sha256
  on public.crawler_notice_assets (sha256) where sha256 is not null;
create index if not exists idx_crawler_notice_assets_status
  on public.crawler_notice_assets (status);

drop trigger if exists trg_crawler_notice_assets_updated_at on public.crawler_notice_assets;
create trigger trg_crawler_notice_assets_updated_at
  before update on public.crawler_notice_assets
  for each row execute function public.set_updated_at();

create table if not exists public.crawler_keyword_matches (
  id bigint generated always as identity primary key,
  notice_id bigint not null references public.crawler_notices(id) on delete cascade,
  rule_version text not null,
  keyword text not null,
  field text not null,
  offset_start integer null,
  offset_end integer null,
  score numeric(8,4) null,
  created_at timestamptz not null default now(),
  constraint crawler_keyword_matches_offsets_check
    check (
      (offset_start is null and offset_end is null)
      or (offset_start is not null and offset_end is not null and offset_start >= 0 and offset_end >= offset_start)
    )
);

comment on table public.crawler_keyword_matches is
  'Keyword/rule evidence used to classify a canonical notice as a scholarship candidate.';

create index if not exists idx_crawler_keyword_matches_notice_id
  on public.crawler_keyword_matches (notice_id);
create index if not exists idx_crawler_keyword_matches_rule_version
  on public.crawler_keyword_matches (rule_version);

-- 4. Run, audit, and error history -----------------------------------------

create table if not exists public.crawler_source_results (
  run_id uuid not null references public.crawler_runs(id) on delete cascade,
  source_id bigint not null references public.crawler_notice_sources(id) on delete cascade,
  decision text not null,
  counts jsonb not null default '{}'::jsonb,
  strategy_code text null,
  adapter_code text null,
  elapsed_ms integer null,
  error_count integer not null default 0,
  primary_failure_code text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (run_id, source_id),
  constraint crawler_source_results_elapsed_check
    check (elapsed_ms is null or elapsed_ms >= 0),
  constraint crawler_source_results_error_count_check
    check (error_count >= 0)
);

comment on table public.crawler_source_results is
  'Per-run source result from the production crawler.';

create index if not exists idx_crawler_source_results_source_id
  on public.crawler_source_results (source_id);
create index if not exists idx_crawler_source_results_decision
  on public.crawler_source_results (decision);

create table if not exists public.crawler_audit_results (
  id bigint generated always as identity primary key,
  run_id uuid null references public.crawler_runs(id) on delete set null,
  source_id bigint not null references public.crawler_notice_sources(id) on delete cascade,
  decision text not null,
  failure_code text null,
  access_profile jsonb not null default '{}'::jsonb,
  sample jsonb not null default '{}'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.crawler_audit_results is
  'Capability audit result history. Stores decision evidence without raw HTML snapshots.';

create unique index if not exists uq_crawler_audit_results_run_source
  on public.crawler_audit_results (run_id, source_id)
  where run_id is not null;
create index if not exists idx_crawler_audit_results_source_id
  on public.crawler_audit_results (source_id);
create index if not exists idx_crawler_audit_results_decision
  on public.crawler_audit_results (decision);

create table if not exists public.crawler_errors (
  id bigint generated always as identity primary key,
  run_id uuid null references public.crawler_runs(id) on delete set null,
  source_id bigint null references public.crawler_notice_sources(id) on delete set null,
  notice_id bigint null references public.crawler_notices(id) on delete set null,
  occurrence_id bigint null references public.crawler_notice_occurrences(id) on delete set null,
  stage text not null,
  error_class text null,
  http_status integer null,
  retry_count integer not null default 0,
  message text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint crawler_errors_http_status_check
    check (http_status is null or (http_status >= 100 and http_status <= 599)),
  constraint crawler_errors_retry_count_check
    check (retry_count >= 0)
);

comment on table public.crawler_errors is
  'Structured crawler, ingest, asset, and audit errors for retry and incident analysis.';

create index if not exists idx_crawler_errors_run_id
  on public.crawler_errors (run_id) where run_id is not null;
create index if not exists idx_crawler_errors_source_id
  on public.crawler_errors (source_id) where source_id is not null;
create index if not exists idx_crawler_errors_stage
  on public.crawler_errors (stage);
create index if not exists idx_crawler_errors_created_at
  on public.crawler_errors (created_at desc);

-- 5. RLS -------------------------------------------------------------------
-- These are internal crawler/admin tables. Service-role ingest bypasses RLS;
-- authenticated admins can inspect and manage rows through server actions.

alter table public.crawler_notice_sources enable row level security;
alter table public.crawler_source_targets enable row level security;
alter table public.crawler_notices enable row level security;
alter table public.crawler_notice_url_aliases enable row level security;
alter table public.crawler_runs enable row level security;
alter table public.crawler_notice_occurrences enable row level security;
alter table public.crawler_notice_targets enable row level security;
alter table public.crawler_notice_assets enable row level security;
alter table public.crawler_keyword_matches enable row level security;
alter table public.crawler_source_results enable row level security;
alter table public.crawler_audit_results enable row level security;
alter table public.crawler_errors enable row level security;

drop policy if exists "crawler_notice_sources_admin_all" on public.crawler_notice_sources;
create policy "crawler_notice_sources_admin_all"
  on public.crawler_notice_sources for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "crawler_source_targets_admin_all" on public.crawler_source_targets;
create policy "crawler_source_targets_admin_all"
  on public.crawler_source_targets for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "crawler_notices_admin_all" on public.crawler_notices;
create policy "crawler_notices_admin_all"
  on public.crawler_notices for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "crawler_notice_url_aliases_admin_all" on public.crawler_notice_url_aliases;
create policy "crawler_notice_url_aliases_admin_all"
  on public.crawler_notice_url_aliases for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "crawler_runs_admin_all" on public.crawler_runs;
create policy "crawler_runs_admin_all"
  on public.crawler_runs for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "crawler_notice_occurrences_admin_all" on public.crawler_notice_occurrences;
create policy "crawler_notice_occurrences_admin_all"
  on public.crawler_notice_occurrences for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "crawler_notice_targets_admin_all" on public.crawler_notice_targets;
create policy "crawler_notice_targets_admin_all"
  on public.crawler_notice_targets for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "crawler_notice_assets_admin_all" on public.crawler_notice_assets;
create policy "crawler_notice_assets_admin_all"
  on public.crawler_notice_assets for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "crawler_keyword_matches_admin_all" on public.crawler_keyword_matches;
create policy "crawler_keyword_matches_admin_all"
  on public.crawler_keyword_matches for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "crawler_source_results_admin_all" on public.crawler_source_results;
create policy "crawler_source_results_admin_all"
  on public.crawler_source_results for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "crawler_audit_results_admin_all" on public.crawler_audit_results;
create policy "crawler_audit_results_admin_all"
  on public.crawler_audit_results for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "crawler_errors_admin_all" on public.crawler_errors;
create policy "crawler_errors_admin_all"
  on public.crawler_errors for all using (public.is_admin()) with check (public.is_admin());

-- 6. Operator summary ------------------------------------------------------

select
  'crawler_normalized_schema_v2' as migration,
  'ok' as status,
  now() as checked_at;
