import assert from "node:assert/strict";
import http from "node:http";
import {
  auditDetails,
  extractFromListWithMetrics,
} from "./audit-crawler-capabilities.mjs";
import {
  ACCESS_PROFILES,
  FAILURE_CODES,
  classifyFetchFailure,
  decidePrimaryFailureCode,
  extractDetailTitleCandidatesFromHtml,
  inferAccessProfileDetails,
  inferAccessProfiles,
  makeSourceDecision,
  verifyDetailTitleIdentity,
} from "../lib/crawler-observability.mjs";

const baseSource = {
  sourceId: "test_001",
  sourceName: "Test Source",
  universitySlug: "test",
  sourceLevel: "department",
  listUrl: "https://department.example.edu/notices",
  baseUrl: "https://department.example.edu",
  listItemSelector: "tbody tr",
  keywords: ["scholarship"],
  adapter: "",
};

assert.equal(
  classifyFetchFailure(new Error("HTTP 429"), 429),
  FAILURE_CODES.BOT_BLOCKED_OR_RATE_LIMITED,
);

const nestedTlsError = new TypeError("fetch failed", {
  cause: Object.assign(new Error("unable to verify the first certificate"), {
    code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  }),
});
assert.equal(
  classifyFetchFailure(nestedTlsError),
  FAILURE_CODES.TLS_OR_CERTIFICATE_EXCEPTION,
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

const postSearchFormWithGetDetailProfiles = inferAccessProfiles({
  source: baseSource,
  html: `
    <form method="post" action="/search"><input name="keyword"></form>
    <table><tbody><tr><td><a href="/notice?mode=view&articleNo=123">Scholarship Notice</a></td></tr></tbody></table>
  `,
  httpStatus: 200,
  charset: "utf-8",
  selectorMatchCount: 1,
  linkExtractionCount: 1,
  validDetailUrlCount: 1,
});
assert.ok(!postSearchFormWithGetDetailProfiles.includes(ACCESS_PROFILES.FORM_POST_REDIRECT));
assert.equal(
  makeSourceDecision({
    profiles: postSearchFormWithGetDetailProfiles,
    failureCode: "",
    finalCandidateCount: 1,
    detailSampleCount: 1,
    detailFetchSuccessCount: 1,
    detailUrlVerifiedCount: 1,
    detailContentCharCount: 120,
    cleanDetailSampleCount: 1,
  }),
  "supported",
);

assert.ok(
  !inferAccessProfiles({
    source: baseSource,
    html: '<table><tr><td><a href="/notice/1" onclick="trackClick()">Scholarship Notice</a></td></tr></table>',
    selectorMatchCount: 1,
    linkExtractionCount: 1,
    validDetailUrlCount: 1,
  }).includes(ACCESS_PROFILES.FORM_POST_REDIRECT),
);

assert.ok(
  !inferAccessProfiles({
    source: baseSource,
    html: '<nav class="pagination"><a href="?page=2">2</a></nav><table><tr><td><a href="/notice/1">Scholarship Notice</a></td></tr></table>',
    selectorMatchCount: 1,
    linkExtractionCount: 1,
    validDetailUrlCount: 1,
  }).includes(ACCESS_PROFILES.FORM_POST_REDIRECT),
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
  decidePrimaryFailureCode({
    selectorMatchCount: 1,
    linkExtractionCount: 0,
    validDetailUrlCount: 0,
    manualNetworkEvidenceRequiredCount: 1,
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

const formPostRedirectDetails = inferAccessProfileDetails({
    source: { ...baseSource, detailAccessMode: "form_post_redirect" },
    html: '<table><tbody><tr><td><a href="#1" onclick="view(123)">Scholarship</a></td></tr></tbody></table>',
    selectorMatchCount: 1,
    linkExtractionCount: 0,
    validDetailUrlCount: 0,
});
assert.ok(formPostRedirectDetails.profiles.includes(ACCESS_PROFILES.FORM_POST_REDIRECT));
assert.equal(
  formPostRedirectDetails.profileEvidence.FORM_POST_REDIRECT.evidence_type,
  "source_config",
);

assert.equal(
  makeSourceDecision({
    profiles: [ACCESS_PROFILES.FORM_POST_REDIRECT],
    failureCode: "",
    finalCandidateCount: 1,
  }),
  "list_supported_detail_unverified",
);

const matchingDetailHtml = `
  <html>
    <head><title>2026학년도 1학기 성적우수 장학금 신청 안내</title></head>
    <body><h1>2026학년도 1학기 성적우수 장학금 신청 안내</h1></body>
  </html>
`;
assert.equal(
  verifyDetailTitleIdentity(
    "2026학년도 1학기 성적우수 장학금 신청 안내",
    extractDetailTitleCandidatesFromHtml(matchingDetailHtml),
  ).verified,
  true,
);

const mismatchingDetailHtml = `
  <html>
    <head><title>학사일정 변경 안내</title></head>
    <body><h1>학사일정 변경 안내</h1></body>
  </html>
`;
const mismatchingIdentity = verifyDetailTitleIdentity(
  "2026학년도 1학기 성적우수 장학금 신청 안내",
  extractDetailTitleCandidatesFromHtml(mismatchingDetailHtml),
);
assert.equal(mismatchingIdentity.verified, false);
assert.equal(mismatchingIdentity.status, "title_mismatch");

assert.equal(
  makeSourceDecision({
    profiles: [ACCESS_PROFILES.STATIC_HTML_HREF],
    failureCode: FAILURE_CODES.DETAIL_IDENTITY_UNVERIFIED,
    finalCandidateCount: 1,
  }),
  "list_supported_detail_unverified",
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
  "no_posts_detected",
);

assert.equal(
  makeSourceDecision({
    profiles: [ACCESS_PROFILES.JSON_XHR_API],
    failureCode: FAILURE_CODES.FILTERED_OUT_BY_KEYWORD,
    finalCandidateCount: 0,
  }),
  "posts_found_no_scholarship",
);

assert.equal(
  makeSourceDecision({
    profiles: [ACCESS_PROFILES.STATIC_HTML_HREF],
    failureCode: FAILURE_CODES.FILTERED_OUT_BY_KEYWORD,
    finalCandidateCount: 0,
  }),
  "posts_found_no_scholarship",
);

const menuOnly = extractFromListWithMetrics(
  { ...baseSource, listItemSelector: "a[href]", linkSelector: "", titleSelector: "" },
  `
    <header><nav>
      <a href="/">Home</a><a href="/en">English</a><a href="/intro">학부소개</a>
      <a href="/login">로그인</a><a href="/sitemap">사이트맵</a>
    </nav></header>
  `,
);
assert.equal(menuOnly.items.length, 0);
assert.equal(menuOnly.metrics.menuContaminationDetected, true);
assert.equal(
  decidePrimaryFailureCode({
    selectorMatchCount: menuOnly.metrics.listDomItemCount,
    linkExtractionCount: menuOnly.metrics.linkExtractionCount,
    validDetailUrlCount: menuOnly.metrics.validDetailUrlCount,
    listMenuContaminationDetected: menuOnly.metrics.menuContaminationDetected,
    crawledCount: menuOnly.items.length,
    hasConfiguredSelector: true,
    paginationVerified: true,
  }),
  FAILURE_CODES.LIST_SELECTOR_MENU_CONTAMINATION,
);
assert.equal(
  makeSourceDecision({
    profiles: [],
    failureCode: FAILURE_CODES.LIST_SELECTOR_MENU_CONTAMINATION,
    finalCandidateCount: 0,
  }),
  "config_or_selector_fix",
);

const boardHtml = `
  <table class="board-list"><tbody>
    <tr>
      <td class="no">1</td>
      <td class="subject"><a href="/notice/1">2026 Scholarship Application Notice</a></td>
      <td class="writer">admin</td>
      <td class="date">2026.07.01</td>
      <td class="hit">12</td>
    </tr>
  </tbody></table>
  <div class="pagination"><a href="?page=2">2</a></div>
`;
const boardSource = {
  ...baseSource,
  listItemSelector: "tbody tr",
  linkSelector: "a[href]",
  titleSelector: ".subject",
  dateSelector: ".date",
};
const boardExtracted = extractFromListWithMetrics(boardSource, boardHtml);
assert.equal(boardExtracted.items.length, 1);
assert.equal(boardExtracted.metrics.boardEvidenceCount, 1);
assert.equal(boardExtracted.metrics.paginationEvidenceCount, 1);
assert.equal(boardExtracted.items[0].listTitle, "2026 Scholarship Application Notice");
assert.equal(boardExtracted.items[0].listTitleQuality, "clean");
assert.equal(boardExtracted.metrics.detailUrlResolvedCount ?? boardExtracted.metrics.validDetailUrlCount, 1);

const contaminatedCardHtml = `
  <ul class="notice-list">
    <li class="card board">
      <a href="/notice/2">
        <span>General Notice</span>
        <strong>2026 Industry Foundation Scholarship Selection</strong>
        <span>Campus Views 174 Created 2026.07.03 Period 2026.07.03 ~ 2026.07.08 Student Support Team</span>
      </a>
    </li>
  </ul>
`;
const contaminatedCardSource = {
  ...baseSource,
  listItemSelector: ".notice-list li",
  linkSelector: "a[href]",
  titleSelector: "a[href]",
  dateSelector: "",
};
const contaminatedExtracted = extractFromListWithMetrics(contaminatedCardSource, contaminatedCardHtml);
assert.equal(contaminatedExtracted.items.length, 0);
assert.equal(contaminatedExtracted.metrics.contaminatedCandidateCount, 1);
assert.equal(contaminatedExtracted.metrics.contaminatedCandidateLeakCount, 0);
assert.equal(
  verifyDetailTitleIdentity(
    "General Notice 2026 Industry Foundation Scholarship Selection Campus Views 174 Created 2026.07.03",
    ["2026 Industry Foundation Scholarship Selection"],
    {
      rawListText: "General Notice 2026 Industry Foundation Scholarship Selection Campus Views 174 Created 2026.07.03",
      listTitleQuality: "contaminated",
    },
  ).verified,
  false,
);

const unverifiedFailure = decidePrimaryFailureCode({
  selectorMatchCount: boardExtracted.metrics.listDomItemCount,
  linkExtractionCount: boardExtracted.metrics.linkExtractionCount,
  validDetailUrlCount: boardExtracted.metrics.validDetailUrlCount,
  detailSampleCount: 0,
  crawledCount: boardExtracted.items.length,
  keywordMatchCount: boardExtracted.metrics.keywordMatchCount,
  parsedDateCount: boardExtracted.metrics.parsedDateCount,
  finalCandidateCount: 1,
  hasConfiguredSelector: true,
  paginationVerified: true,
});
assert.equal(unverifiedFailure, FAILURE_CODES.DETAIL_URL_UNVERIFIED);
assert.equal(
  makeSourceDecision({
    profiles: [ACCESS_PROFILES.STATIC_HTML_HREF],
    failureCode: unverifiedFailure,
    finalCandidateCount: 1,
  }),
  "list_supported_detail_unverified",
);

const onclickOnly = extractFromListWithMetrics(
  {
    ...baseSource,
    sourceId: "korea_999",
    listItemSelector: "tbody tr",
    linkSelector: "a[href]",
    titleSelector: ".subject",
    dateSelector: ".date",
  },
  `
    <table class="board-list"><tbody>
      <tr>
        <td>1</td><td class="subject"><a href="#1" onclick="jf_view('123','456','site')">2026 Scholarship Notice</a></td>
        <td class="date">2026.07.01</td>
      </tr>
    </tbody></table>
  `,
);
assert.equal(onclickOnly.items.length, 0);
assert.equal(onclickOnly.metrics.manualNetworkEvidenceRequiredCount, 1);
assert.equal(
  decidePrimaryFailureCode({
    selectorMatchCount: onclickOnly.metrics.listDomItemCount,
    linkExtractionCount: onclickOnly.metrics.linkExtractionCount,
    validDetailUrlCount: onclickOnly.metrics.validDetailUrlCount,
    manualNetworkEvidenceRequiredCount: onclickOnly.metrics.manualNetworkEvidenceRequiredCount,
    crawledCount: onclickOnly.items.length,
    hasConfiguredSelector: true,
    paginationVerified: true,
  }),
  FAILURE_CODES.MANUAL_BROWSER_NETWORK_REQUIRED,
);

const server = http.createServer((request, response) => {
  if (request.url === "/notice/1") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`
      <html><head><title>2026 Scholarship Application Notice</title></head>
      <body><main><h1>2026 Scholarship Application Notice</h1>
      <p>This scholarship notice contains application period, eligibility, required documents, and contact details for students.</p>
      <p>Please read the official notice and submit documents before the deadline.</p></main></body></html>
    `);
    return;
  }
  if (request.url === "/notice/2") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`
      <html><head><title>2026 Industry Foundation Scholarship Selection</title></head>
      <body><article><h1>2026 Industry Foundation Scholarship Selection</h1>
      <p>This detail page has a real scholarship body with eligibility, application method, schedule, documents, and contact information.</p>
      <p>The text is long enough to be treated as meaningful notice body content.</p></article></body></html>
    `);
    return;
  }
  response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
  response.end("<html><title>Not Found</title></html>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const { port } = server.address();
  const localSource = {
    ...boardSource,
    listUrl: `http://127.0.0.1:${port}/notices`,
    baseUrl: `http://127.0.0.1:${port}`,
  };
  const localExtracted = extractFromListWithMetrics(localSource, boardHtml);
  const detailResults = await auditDetails(localSource, localExtracted.items, []);
  assert.equal(detailResults.length, 1);
  assert.equal(detailResults[0].fetchStatus, "success");
  assert.equal(detailResults[0].identityVerified, true);
  assert.ok(detailResults[0].contentCharCount >= 80);
  assert.equal(
    makeSourceDecision({
      profiles: [ACCESS_PROFILES.STATIC_HTML_HREF],
      failureCode: "",
      finalCandidateCount: 1,
      detailSampleCount: detailResults.length,
      detailFetchSuccessCount: 1,
      detailUrlVerifiedCount: 1,
      detailContentCharCount: detailResults[0].contentCharCount,
      cleanDetailSampleCount: 1,
    }),
    "supported",
  );

  const menuPlusBoardHtml = `
    <header><nav><a href="/">Home</a><a href="/login">Login</a><a href="/about">About</a></nav></header>
    ${boardHtml}
  `;
  const menuPlusBoardExtracted = extractFromListWithMetrics(localSource, menuPlusBoardHtml);
  assert.equal(menuPlusBoardExtracted.metrics.menuContaminationObserved, true);
  assert.equal(menuPlusBoardExtracted.metrics.contaminatedCandidateLeakCount, 0);
  const menuPlusBoardDetails = await auditDetails(localSource, menuPlusBoardExtracted.items, []);
  assert.equal(menuPlusBoardDetails[0].identityVerified, true);
  assert.equal(
    makeSourceDecision({
      profiles: [ACCESS_PROFILES.STATIC_HTML_HREF],
      failureCode: "",
      finalCandidateCount: 1,
      detailSampleCount: 1,
      detailFetchSuccessCount: 1,
      detailUrlVerifiedCount: 1,
      detailContentCharCount: menuPlusBoardDetails[0].contentCharCount,
      cleanDetailSampleCount: 1,
      contaminatedCandidateLeakCount: 0,
    }),
    "supported",
  );

  const contaminatedDetails = await auditDetails(
    localSource,
    contaminatedExtracted.items.map((item) => ({
      ...item,
      noticeUrl: `http://127.0.0.1:${port}/notice/2`,
    })),
    [],
  );
  assert.equal(contaminatedDetails.length, 0);
  const contaminatedFailure = decidePrimaryFailureCode({
    selectorMatchCount: contaminatedExtracted.metrics.listDomItemCount,
    linkExtractionCount: contaminatedExtracted.metrics.linkExtractionCount,
    validDetailUrlCount: contaminatedExtracted.metrics.validDetailUrlCount,
    contaminatedCandidateLeakCount: contaminatedExtracted.metrics.contaminatedCandidateLeakCount,
    detailSampleCount: 0,
    detailFetchSuccessCount: 0,
    detailUrlVerifiedCount: 0,
    detailIdentityUnverifiedCount: 0,
    crawledCount: 0,
    keywordMatchCount: 0,
    parsedDateCount: 0,
    finalCandidateCount: 0,
    hasConfiguredSelector: true,
    paginationVerified: true,
  });
  assert.equal(contaminatedFailure, FAILURE_CODES.ZERO_RECENT_NOTICES);
  assert.equal(
    makeSourceDecision({
      profiles: [ACCESS_PROFILES.STATIC_HTML_HREF],
      failureCode: contaminatedFailure,
      finalCandidateCount: 0,
    }),
    "no_posts_detected",
  );

  const failedDetails = await auditDetails(
    localSource,
    [{ ...localExtracted.items[0], noticeUrl: `http://127.0.0.1:${port}/missing` }],
    [],
  );
  assert.equal(failedDetails[0].fetchStatus, "failed");
  const detailFailedCode = decidePrimaryFailureCode({
    selectorMatchCount: 1,
    linkExtractionCount: 1,
    validDetailUrlCount: 1,
    detailFailureCount: 1,
    detailSampleCount: 1,
    crawledCount: 1,
    keywordMatchCount: 1,
    parsedDateCount: 1,
    finalCandidateCount: 1,
    hasConfiguredSelector: true,
    paginationVerified: true,
  });
  assert.equal(detailFailedCode, FAILURE_CODES.DETAIL_FETCH_FAILED);
  assert.equal(
    makeSourceDecision({
      profiles: [ACCESS_PROFILES.STATIC_HTML_HREF],
      failureCode: detailFailedCode,
      finalCandidateCount: 1,
      detailSampleCount: 1,
    }),
    "list_supported_detail_failed",
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log("crawler_observability_tests=passed");
