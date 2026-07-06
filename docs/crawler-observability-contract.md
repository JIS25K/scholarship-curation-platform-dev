# Crawler Observability Contract

## Purpose

The capability audit records what the current crawler can verify for each enabled source. It is read-only: it must not write to Supabase, modify source CSV files, bypass access controls, or store sensitive request data.

## Scope

- The current audit covers all enabled sources in `data/notice-sources.csv`, including any existing `department` sources.
- Audit filters are execution controls for sampling/debugging only; they are not a policy to exclude department sources from the full audit.
- Future Source Discovery may add university headquarters and college-level sources.
- Future Source Discovery must not newly register department websites until that scope is explicitly reopened.

## Artifact Files

Default directory:

```text
exports/notices/diagnostics/
```

Files:

- `capability-audit-YYYYMMDD-RUNID.json`
- `capability-audit-YYYYMMDD-RUNID.csv`
- `capability-audit-latest.json`
- `capability-audit-latest.csv`
- `capability-audit-university-summary-YYYYMMDD-RUNID.csv`
- `capability-audit-university-summary-latest.csv`
- `capability-audit-profile-summary-YYYYMMDD-RUNID.md`
- `capability-audit-profile-summary-latest.md`
- `capability-audit-form-post-redirect-evidence-YYYYMMDD-RUNID.csv`
- `capability-audit-form-post-redirect-evidence-latest.csv`
- `capability-audit-form-post-redirect-evidence-YYYYMMDD-RUNID.md`
- `capability-audit-form-post-redirect-evidence-latest.md`
- `failed-sources-latest.json`
- `needs-adapter-latest.json`
- `manual-review-required-latest.json`

The source CSV is generated automatically from audit evidence. It is not a manually maintained spreadsheet. Each enabled source must produce exactly one JSON object in `perSource` and one row in the source CSV.

Required source CSV columns:

- `source_id`
- `source_name`
- `source_config_file`
- `university_slug`
- `source_level`
- `adapter`
- `list_url`
- `list_fetch_status`
- `list_parse_status`
- `item_match_count`
- `title_extract_rate`
- `date_extract_rate`
- `detail_url_resolution_rate`
- `detail_url_resolved`
- `detail_url_verified`
- `detail_fetch_status`
- `detail_content_status`
- `detail_content_char_count`
- `pagination_status`
- `access_profiles`
- `capability_status`
- `recommended_action`
- `manual_review_question`
- `failure_codes`
- `evidence_summary`

Status-like columns must use explicit values such as `success`, `warning`, `failed`, `skipped`, or `manual_review_required`; do not leave them blank. Optional text fields should use `none` when no action, adapter, manual question, failure code, or profile applies.

The university summary CSV groups source counts, decisions, failure codes, and access profiles by `university_slug`. The profile summary Markdown table groups the same run by access profile. The FORM_POST_REDIRECT evidence CSV/Markdown groups sources by direct evidence type. Neither artifact may store full raw HTML, cookies, authorization headers, session IDs, credentials, or CAPTCHA/login bypass data.

`profileEvidence` maps each access profile to a concise reason:

```json
{
  "FORM_POST_REDIRECT": {
    "reason": "source_config.detail_access_mode=form_post_redirect",
    "evidence_type": "source_config",
    "evidence_value": "form_post_redirect"
  }
}
```

Every `FORM_POST_REDIRECT` source must have direct evidence type `source_config`, `browser_network_evidence`, `adapter_capability`, or `parser_evidence`. General POST forms, generic onclick handlers, pagination controls, search forms, and JavaScript function names are not valid FORM_POST_REDIRECT evidence by themselves.

## Source Summary Schema

Each `perSource` entry includes:

- `runId`
- `sourceId`, `sourceName`, `sourceConfigFile`
- `universitySlug`, `sourceLevel`
- `adapter`
- `listUrl`
- `accessProfiles`
- `profileEvidence`
- `failureCode`
- `decision`
- `capabilityStatus`
- `recommendedAction`
- `manualReviewQuestion`
- `metrics`
- `samples`

Important metrics:

- `listDomItemCount`
- `selectorMatches`
- `linkExtractionCount`
- `validDetailUrlCount`
- `manualNetworkEvidenceRequiredCount`
- `detailUrlResolvedCount`
- `detailUrlVerifiedCount`
- `detailIdentityUnverifiedCount`
- `detailContentEmptyCount`
- `finalCandidateCount`

## Stage Event Schema

Each stage event includes:

- `runId`
- `sourceId`, `sourceName`, `universitySlug`, `sourceLevel`
- `stage`
- `status`
- `startedAt`, `endedAt`, `elapsedMs`
- `httpStatus`
- `finalUrl`
- `redirected`
- `responseContentType`
- `detectedCharset`
- `responseByteLength`
- `retryCount`
- `lastErrorName`, `lastErrorMessage`, `lastErrorCode`
- `failureCode`
- `evidence`

Stages:

- `list_fetch`
- `list_decode`
- `list_parse`
- `notice_url_resolution`
- `pagination_check`
- `detail_fetch`
- `detail_content_extract`
- `candidate_filter`
- `final_result`

## Verification Terms

- `detail_url_resolved`: the crawler produced a detail URL string from DOM or adapter data.
- `detail_url_verified`: the crawler fetched a sample detail page through a valid public GET or registered adapter path and the list title sufficiently matched the detail page title, heading, or title-like body text after normalization.
- `detail_content_verified`: the fetched detail page had enough meaningful text for extraction.

These are intentionally separate. A string that looks like a URL is not proof that a detail page is reachable or correct. HTTP 200 alone is not enough to verify detail identity.

If the detail fetch succeeds but title identity cannot be verified, set `detail_url_verified` to false or warning evidence and classify the source as `supported_with_unverified_identity` rather than `adapter_required`, unless separate access-control or browser-network evidence requires manual review.

Do not mark detail URLs verified for:

- `href="#1"`
- `href="javascript:void(0)"`
- placeholder links that depend on `onclick`
- portal handlers such as `jf_view(article_id, board_id, site_id)` without browser Network evidence

Known example:

- Some Korea University portal boards use `href="#1"` and `onclick="jf_view(...)"`.
- Browser navigation performs `POST /portalBoard/{site_id}/{board_id}/{article_id}/portalBoardView.do`.
- The POST returns a `302` redirect to a final URL containing `enc`.
- Until that request method, payload, and redirect chain are captured from the browser Network panel, classify the source as `MANUAL_BROWSER_NETWORK_REQUIRED` rather than `detail_url_verified`.

`FORM_POST_REDIRECT` must only be assigned when direct evidence shows that detail access itself needs POST and redirect. Valid evidence includes `detail_access_mode=form_post_redirect` source metadata, adapter metadata or execution proving POST-to-redirect detail access, a placeholder detail link tied to an article id and concrete POST action, or user-provided browser Network evidence. A search form or ordinary board form using `method="post"` elsewhere in the list HTML is not enough.

Decision meanings:

- `supported`: the current crawler path resolved, fetched, and verified sampled detail identity.
- `supported_with_unverified_identity`: the current crawler path fetched detail pages, but sampled detail identity was not confirmed by title matching. This is not an adapter requirement.
- `adapter_required`: a public source-specific endpoint, XHR, POST-detail flow, or client-rendered navigation requires source-specific implementation.
- `manual_review_required`: browser Network, access policy, CAPTCHA/login, bot blocking, or other manual evidence is needed before implementation.

## Failure Codes

- `URL_DEAD_DNS`
- `URL_DEAD_HTTP_404_410`
- `SERVER_ERROR_5XX`
- `TIMEOUT_OR_CONNECTION_ABORTED`
- `TLS_OR_CERTIFICATE_EXCEPTION`
- `BOT_BLOCKED_OR_RATE_LIMITED`
- `AUTH_OR_CAPTCHA_REQUIRED`
- `LIST_SELECTOR_ZERO_MATCHES`
- `URL_RESOLUTION_FAILED`
- `DETAIL_FETCH_FAILED`
- `DETAIL_CONTENT_EMPTY_OR_BOILERPLATE`
- `DETAIL_IDENTITY_UNVERIFIED`
- `ZERO_RECENT_NOTICES`
- `FILTERED_OUT_BY_DATE`
- `FILTERED_OUT_BY_KEYWORD`
- `PAGINATION_UNVERIFIED`
- `ADAPTER_REQUIRED`
- `CONFIG_OR_SELECTOR_MISMATCH`
- `MANUAL_BROWSER_NETWORK_REQUIRED`
- `UNKNOWN_NEEDS_MANUAL_REVIEW`

## Sensitive Data Rules

Do not store:

- full raw HTML
- cookies
- authorization headers
- session identifiers
- CAPTCHA or login bypass data
- private tokens

Store only concise public evidence such as source URL, final URL, HTTP status, counts, and short error summaries.

## Manual Test Checklist

- Run `npm run test:crawler-observability`.
- Run `npm run test:crawler-adapters`.
- Run a small dry-run audit: `AUDIT_LIMIT=1 AUDIT_DETAIL_SAMPLE_SIZE=0 npm run audit:crawler-capabilities`.
- Confirm `capability-audit-latest.json`, CSV output, `needs-adapter-latest.json`, and `manual-review-required-latest.json` are generated.
- Confirm a `href="#1" + onclick="jf_view(...)"` fixture is not treated as a verified detail URL.
