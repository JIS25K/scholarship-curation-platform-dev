import assert from "node:assert/strict";
import {
  ACCESS_PROFILES,
  FAILURE_CODES,
  classifyFetchFailure,
  decidePrimaryFailureCode,
  inferAccessProfiles,
  makeSourceDecision,
} from "../lib/crawler-observability.mjs";

const baseSource = {
  sourceId: "test_001",
  sourceName: "Test Source",
  universitySlug: "test",
  sourceLevel: "department",
  listItemSelector: "tbody tr",
  adapter: "",
};

assert.equal(
  classifyFetchFailure(new Error("HTTP 429"), 429),
  FAILURE_CODES.BOT_BLOCKED_OR_RATE_LIMITED,
);

assert.deepEqual(
  inferAccessProfiles({
    source: baseSource,
    html: '<table><tbody><tr><td><a href="/notice/1">Scholarship</a></td></tr></tbody></table>',
    httpStatus: 200,
    charset: "utf-8",
    selectorMatchCount: 1,
    linkExtractionCount: 1,
    validDetailUrlCount: 1,
  }),
  [ACCESS_PROFILES.STATIC_HTML_HREF],
);

assert.ok(
  inferAccessProfiles({
    source: baseSource,
    html: '<div id="root"></div><script src="/app.js"></script>',
    httpStatus: 200,
    charset: "utf-8",
    selectorMatchCount: 0,
    linkExtractionCount: 0,
    validDetailUrlCount: 0,
  }).includes(ACCESS_PROFILES.CLIENT_RENDERED_OR_JS_REQUIRED),
);

assert.equal(
  decidePrimaryFailureCode({
    selectorMatchCount: 0,
    linkExtractionCount: 0,
    validDetailUrlCount: 0,
    crawledCount: 0,
    hasConfiguredSelector: true,
    paginationVerified: true,
  }),
  FAILURE_CODES.LIST_SELECTOR_ZERO_MATCHES,
);

assert.equal(
  decidePrimaryFailureCode({
    selectorMatchCount: 5,
    linkExtractionCount: 5,
    validDetailUrlCount: 5,
    crawledCount: 5,
    keywordMatchCount: 0,
    parsedDateCount: 5,
    finalCandidateCount: 0,
    hasConfiguredSelector: true,
    paginationVerified: true,
  }),
  FAILURE_CODES.FILTERED_OUT_BY_KEYWORD,
);

assert.equal(
  decidePrimaryFailureCode({
    selectorMatchCount: 5,
    linkExtractionCount: 0,
    validDetailUrlCount: 0,
    manualNetworkEvidenceRequiredCount: 5,
    crawledCount: 0,
    hasConfiguredSelector: true,
    paginationVerified: true,
  }),
  FAILURE_CODES.MANUAL_BROWSER_NETWORK_REQUIRED,
);

assert.equal(
  makeSourceDecision({
    profiles: [ACCESS_PROFILES.STATIC_HTML_EVENT_URL],
    failureCode: FAILURE_CODES.MANUAL_BROWSER_NETWORK_REQUIRED,
    finalCandidateCount: 0,
  }),
  "manual_review_required",
);

assert.equal(
  makeSourceDecision({
    profiles: [ACCESS_PROFILES.JSON_XHR_API],
    failureCode: "",
    finalCandidateCount: 2,
  }),
  "adapter_required",
);

assert.equal(
  makeSourceDecision({
    profiles: [ACCESS_PROFILES.STATIC_HTML_HREF],
    failureCode: FAILURE_CODES.ZERO_RECENT_NOTICES,
    finalCandidateCount: 0,
  }),
  "valid_zero_candidates",
);

console.log("crawler_observability_tests=passed");
