# Crawler Capability Audit

## Current Architecture

Verified from:

- `scripts/crawl-scholarship-notices.mjs`
- `lib/crawler-adapters/index.mjs`
- `data/notice-sources.csv`
- `scripts/diagnose-notice-sources.mjs`
- `scripts/report-dead-link-candidates.mjs`
- `scripts/compare-crawler-vs-db-by-university.mjs`
- `package.json`

The crawler flow is:

1. Read enabled sources from `data/notice-sources.csv`.
2. Filter sources by optional environment variables such as source prefix, allowlist, source level, or college name.
3. For each source, use a registered list adapter when `adapter` is set.
4. Otherwise fetch `list_url`, decode HTML with header/meta/fallback charset detection, and parse with Cheerio.
5. Resolve notice URLs from `href`, `data-*`, `onclick`, source-specific event patterns, or script text.
6. Optionally fetch detail pages and extract content/date selectors.
7. Filter by scholarship keywords and lookback dates.
8. Write local JSON/CSV reports and update a local seen-state file.

The current registered adapter is:

- `cau_portal`: posts to a public CAU CMS JSON endpoint discovered from the source page form.

Existing support scripts already cover:

- broad source diagnostics: `scripts/diagnose-notice-sources.mjs`
- crawl quality evaluation: `scripts/evaluate-crawl-quality.mjs`
- source health over historical reports: `scripts/evaluate-source-health.mjs`
- dead-link candidate reporting: `scripts/report-dead-link-candidates.mjs`
- crawler-vs-DB comparison: `scripts/compare-crawler-vs-db-by-university.mjs`

## Verified Capabilities

- Static HTML lists can be parsed with configured selectors.
- Fallback anchor scanning exists when no list selector is configured.
- Korean legacy encodings can be decoded through charset probing and `euc-kr` fallback.
- Detail fetch can be disabled with `CRAWL_DETAIL_FETCH=false`.
- Existing crawler execution is sequential by default and can be configured with `CRAWL_SOURCE_CONCURRENCY`.
- Request timeout, retry count, and backoff are configurable with environment variables.
- The crawler records per-source counts and errors in the normal crawl report.

## Partially Supported Or Unverified Areas

- Pagination support is heuristic unless a source adapter implements it.
- `onclick`, form POST, redirect, and session-like flows are only partially handled by generic URL extraction.
- Attachment download success is not verified by the normal crawler.
- Detail fetch success and detail content extraction success are not separately reported in the normal crawl report.
- `0 candidates` can mean no recent scholarship notices, selector/config drift, keyword filtering, date filtering, or detail failures; these were not separated in the normal report.
- Browser Network verification is still manual for sources that require public XHR discovery.

## Added Audit Layer

This change adds:

- `lib/crawler-observability.mjs`
- `scripts/audit-crawler-capabilities.mjs`
- `scripts/test-crawler-observability.mjs`
- `npm run audit:crawler-capabilities`
- `npm run test:crawler-observability`

The audit layer is dry-run only. It does not write to Supabase, does not mutate source CSV files, and does not modify administrator data.

## Scope Rules

- This audit targets every currently enabled source in `data/notice-sources.csv`, regardless of `source_level`. Existing department-level sources remain in the audit target set.
- Optional environment filters such as source prefix, allowlist, and limit are only for local debugging or smaller verification runs; they do not redefine the default audit scope.
- Future Source Discovery expansion is limited to university headquarters and college-level sources for now.
- Department websites are temporarily excluded from new Source Discovery registration. This does not remove or skip department sources that are already enabled in the current source config.

## Source Profiles

Each source can receive one or more profiles:

- `STATIC_HTML_HREF`
- `STATIC_HTML_EVENT_URL`
- `FORM_POST_REDIRECT`
- `JSON_XHR_API`
- `SERVER_RENDERED_WITH_PAGINATION`
- `CLIENT_RENDERED_OR_JS_REQUIRED`
- `LEGACY_CHARSET`
- `TLS_OR_CERTIFICATE_EXCEPTION`
- `BOT_BLOCKED_OR_RATE_LIMITED`
- `AUTH_OR_CAPTCHA_REQUIRED`
- `DETAIL_PAGE_UNREACHABLE`
- `ATTACHMENT_ACCESS_UNVERIFIED`
- `SOURCE_CONFIG_OR_SELECTOR_MISMATCH`
- `UNKNOWN_NEEDS_MANUAL_REVIEW`

## Failure Type Summary

The audit separates:

- dead URL or DNS failure
- 404/410
- 5xx server error
- timeout or connection abort
- TLS/certificate problem
- bot blocking or rate limiting
- authentication or CAPTCHA requirement
- list selector zero matches
- URL resolution failure
- detail fetch failure
- empty or boilerplate detail content
- detail identity not verified by title matching
- no recent notices
- date-filtered notices
- keyword-filtered notices
- unverified pagination
- config/selector mismatch
- browser Network review required

## Priority Guidance

Adapter candidates:

- Sources classified as `JSON_XHR_API`
- Sources classified as `FORM_POST_REDIRECT`
- Sources classified as `CLIENT_RENDERED_OR_JS_REQUIRED`
- Sources with valid public list pages but repeat `URL_RESOLUTION_FAILED`

Config/selector candidates:

- Sources with `SOURCE_CONFIG_OR_SELECTOR_MISMATCH`
- Sources with `LIST_SELECTOR_ZERO_MATCHES`
- Sources with links present but `noticeUrlPattern` excluding valid URLs

Manual review candidates:

- Sources classified as `AUTH_OR_CAPTCHA_REQUIRED`
- Sources classified as `BOT_BLOCKED_OR_RATE_LIMITED`
- Sources with TLS/certificate exceptions
- Sources that need browser Network inspection to identify whether a public endpoint exists

## Baseline Execution

Recommended safe first run:

```bash
AUDIT_LIMIT=5 AUDIT_DETAIL_SAMPLE_SIZE=1 npm run audit:crawler-capabilities
```

Full run:

```bash
npm run audit:crawler-capabilities
```

Outputs:

- `exports/notices/diagnostics/capability-audit-latest.json`
- `exports/notices/diagnostics/capability-audit-YYYYMMDD-RUNID.csv`
- `exports/notices/diagnostics/capability-audit-latest.csv`
- `exports/notices/diagnostics/capability-audit-university-summary-YYYYMMDD-RUNID.csv`
- `exports/notices/diagnostics/capability-audit-university-summary-latest.csv`
- `exports/notices/diagnostics/capability-audit-profile-summary-YYYYMMDD-RUNID.md`
- `exports/notices/diagnostics/capability-audit-profile-summary-latest.md`
- `exports/notices/diagnostics/failed-sources-latest.json`
- `exports/notices/diagnostics/needs-adapter-latest.json`
- `exports/notices/diagnostics/manual-review-required-latest.json`

The source CSV is automatically generated with one row per enabled source. Required columns are `source_id`, `source_name`, `source_config_file`, `university_slug`, `source_level`, `adapter`, `list_url`, `list_fetch_status`, `list_parse_status`, `item_match_count`, `title_extract_rate`, `date_extract_rate`, `detail_url_resolution_rate`, `detail_url_resolved`, `detail_url_verified`, `detail_fetch_status`, `detail_content_status`, `detail_content_char_count`, `pagination_status`, `access_profiles`, `capability_status`, `recommended_action`, `manual_review_question`, `failure_codes`, and `evidence_summary`.

Use explicit status values such as `success`, `warning`, `failed`, `skipped`, or `manual_review_required`; use `none` for optional text fields with no applicable value. Do not store full raw HTML or sensitive request data in the CSV, JSON, university summary, or profile summary.

Important distinction:

- `detail_url_resolved`: a URL string was created.
- `detail_url_verified`: the crawler fetched a detail page and confirmed that the list title sufficiently matches the detail page title, heading, or title-like body text after normalization.
- `detail_content_verified`: the fetched detail page contained meaningful extractable text.

Do not treat HTTP 200 alone as a verified detail URL. If the detail page fetch succeeds but title identity cannot be confirmed, classify the result as `supported_with_unverified_identity` instead of `adapter_required`.

Do not treat placeholder event links as verified URLs. Korea University portal-style rows with `href="#1"` and `onclick="jf_view(article_id, board_id, site_id)"` require browser Network evidence because the browser uses POST and redirect before reaching the final encoded detail URL. This audit should classify that structure as `MANUAL_BROWSER_NETWORK_REQUIRED` instead of synthesizing a fake detail URL.

Do not assign `FORM_POST_REDIRECT` merely because the list HTML contains a search form or ordinary board form with `method="post"`. It requires direct evidence that detail access itself uses POST and redirect.

## Known Limits

- The audit does not crawl private, login-gated, CAPTCHA-gated, or robots-disallowed content.
- The audit does not download attachments by default.
- The audit samples detail pages with `AUDIT_DETAIL_SAMPLE_SIZE`; it is not a full detail crawl unless configured that way.
- JavaScript-rendered sources are classified for adapter/manual review instead of being bypassed.
- Profile inference is evidence-based but still conservative; ambiguous cases remain `UNKNOWN_NEEDS_MANUAL_REVIEW`.

## Manual Test Checklist

- Run `npm run test:crawler-observability`.
- Run `AUDIT_LIMIT=1 AUDIT_DETAIL_SAMPLE_SIZE=0 npm run audit:crawler-capabilities`.
- Confirm `capability-audit-latest.json`, source CSV output, university summary CSV, profile summary Markdown, `failed-sources-latest.json`, `needs-adapter-latest.json`, and `manual-review-required-latest.json` are generated.
- Inspect one source in `stageEvents` and confirm stages appear from `list_fetch` through `final_result`.
- Confirm no application UI, Supabase writes, GitHub Actions, or production data are changed.
