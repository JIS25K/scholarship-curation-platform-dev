import assert from "node:assert/strict";
import {
  extractNoticeUrlFromLinkNode,
  normalizePublicAccessUrl,
  resolveUrlWithHttps,
} from "../lib/crawler-adapters/index.mjs";
import { applyOfficialSourceFallbacks } from "../lib/crawler-source-fallbacks.mjs";

const httpSource = {
  sourceId: "test_001",
  listUrl: "http://department.example.edu/notices",
  baseUrl: "http://department.example.edu",
};

assert.equal(
  resolveUrlWithHttps("/board/view.php?id=1", httpSource.listUrl, httpSource.baseUrl),
  "http://department.example.edu/board/view.php?id=1",
);

assert.equal(resolveUrlWithHttps("#1", httpSource.listUrl, httpSource.baseUrl), "");

assert.equal(
  resolveUrlWithHttps(
    "http://department.example.edu/board/view.php?id=2",
    httpSource.listUrl,
    httpSource.baseUrl,
  ),
  "http://department.example.edu/board/view.php?id=2",
);

assert.equal(
  resolveUrlWithHttps(
    "http://other.example.edu/board/view.php?id=3",
    httpSource.listUrl,
    httpSource.baseUrl,
  ),
  "https://other.example.edu/board/view.php?id=3",
);

const httpsSource = {
  sourceId: "test_002",
  listUrl: "https://department.example.edu/notices",
  baseUrl: "https://department.example.edu",
};

assert.equal(
  resolveUrlWithHttps(
    "http://department.example.edu/board/view.php?id=4",
    httpsSource.listUrl,
    httpsSource.baseUrl,
  ),
  "https://department.example.edu/board/view.php?id=4",
);

const fakeLinkNode = {
  attr(name) {
    return {
      href: "javascript:void(0)",
      onclick: "goView(123)",
    }[name];
  },
};

assert.equal(
  extractNoticeUrlFromLinkNode(
    {
      sourceId: "cau_001",
      listUrl: "https://biz.cau.ac.kr/list.php",
      baseUrl: "https://biz.cau.ac.kr",
    },
    fakeLinkNode,
  ),
  "https://biz.cau.ac.kr/list.php?no=123",
);

const koreaPortalLinkNode = {
  attr(name) {
    return {
      href: "#1",
      onclick: "jf_view('12345', '678', 'siteA')",
    }[name];
  },
};

assert.equal(
  extractNoticeUrlFromLinkNode(
    {
      sourceId: "korea_001",
      listUrl: "https://portal.korea.ac.kr/front/board/list.do",
      baseUrl: "https://portal.korea.ac.kr",
    },
    koreaPortalLinkNode,
  ),
  "",
);

const hanyangLiferayLinkNode = {
  attr(name) {
    return {
      href: "#none",
      onclick: "_kr_ac_hanyang_bbs_web_portlet_BbsPortlet_viewMessage(203206, true, false)",
    }[name];
  },
};
const hanyangNoticeUrl = extractNoticeUrlFromLinkNode(
  {
    sourceId: "hanyang_002",
    listUrl: "https://bizug.hanyang.ac.kr/-3",
    baseUrl: "https://bizug.hanyang.ac.kr",
  },
  hanyangLiferayLinkNode,
);
assert.equal(new URL(hanyangNoticeUrl).searchParams.get("_kr_ac_hanyang_bbs_web_portlet_BbsPortlet_messageId"), "203206");
assert.equal(new URL(hanyangNoticeUrl).searchParams.get("_kr_ac_hanyang_bbs_web_portlet_BbsPortlet_action"), "view_message");

const uosLinkNode = {
  attr(name) {
    return { href: "javascript:void(0)", onclick: "fnView('1', '2002')" }[name];
  },
};
const uosNoticeUrl = extractNoticeUrlFromLinkNode(
  {
    sourceId: "uos_002",
    listUrl: "https://social.uos.ac.kr/social/korNotice/allList.do?list_id=test",
    baseUrl: "https://social.uos.ac.kr",
  },
  uosLinkNode,
);
assert.equal(new URL(uosNoticeUrl).pathname.endsWith("/view.do"), true);
assert.equal(new URL(uosNoticeUrl).searchParams.get("seq"), "2002");
assert.equal(new URL(uosNoticeUrl).searchParams.get("identified"), "anonymous");

assert.equal(
  normalizePublicAccessUrl("https://sports.khu.ac.kr/bbs/board.php?bo_table=05_01"),
  "http://sports.khu.ac.kr/bbs/board.php?bo_table=05_01",
);

const fallbackSources = applyOfficialSourceFallbacks([
  {
    sourceId: "cau_002",
    universitySlug: "cau",
    collegeId: "1",
    listUrl: "https://broken.example/notices",
  },
  {
    sourceId: "cau_univ_001",
    universitySlug: "cau",
    collegeId: "",
    listUrl: "https://www.cau.ac.kr/notices",
    adapter: "cau_portal",
  },
]);
assert.equal(fallbackSources[0].configuredListUrl, "https://broken.example/notices");
assert.equal(fallbackSources[0].fallbackSourceId, "cau_univ_001");
assert.equal(fallbackSources[0].listUrl, "https://www.cau.ac.kr/notices");
assert.equal(fallbackSources[0].adapter, "cau_portal");

console.log("crawler_adapter_tests=passed");
