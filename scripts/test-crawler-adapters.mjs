import assert from "node:assert/strict";
import {
  extractNoticeUrlFromLinkNode,
  resolveUrlWithHttps,
} from "../lib/crawler-adapters/index.mjs";

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

console.log("crawler_adapter_tests=passed");
