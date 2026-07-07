import assert from "node:assert/strict";
import {
  LIST_PARSER_STRATEGIES,
  parseNoticeList,
} from "../lib/crawler-parsers/list-parser.mjs";
import { parseNoticeDetail } from "../lib/crawler-parsers/detail-parser.mjs";

const baseSource = {
  sourceId: "test_001",
  sourceName: "Test University",
  listUrl: "https://example.edu/notices",
  baseUrl: "https://example.edu",
  listItemSelector: "tbody tr",
  linkSelector: "a[href]",
  titleSelector: ".subject",
  dateSelector: ".date",
  noticeUrlPattern: "mode=view",
  keywords: ["scholarship"],
  adapter: "",
};

const configuredHtml = `
  <table><tbody><tr>
    <td class="subject"><a href="/notice?mode=view&id=1">Scholarship Notice</a></td>
    <td class="date">2026.07.07</td>
  </tr></tbody></table>
`;
const configured = parseNoticeList(baseSource, configuredHtml);
assert.equal(configured.items.length, 1);
assert.equal(configured.metrics.parserStrategy, LIST_PARSER_STRATEGIES.CONFIGURED_SELECTOR);
assert.equal(configured.metrics.parserRecovered, false);

const commonBoardHtml = `
  <ul class="notice-list">
    <li class="notice-item">
      <a href="/posts/42">2026 Scholarship Application</a>
      <time>2026.07.07</time>
    </li>
  </ul>
`;
const commonRecovered = parseNoticeList(baseSource, commonBoardHtml);
assert.equal(commonRecovered.items.length, 1);
assert.equal(commonRecovered.metrics.parserStrategy, LIST_PARSER_STRATEGIES.COMMON_BOARD);
assert.equal(commonRecovered.metrics.parserRecovered, true);
assert.equal(commonRecovered.items[0].noticeUrlPatternMatched, false);

const anchorFallbackHtml = `
  <header><nav><a href="/">Home</a><a href="/login">Login</a></nav></header>
  <main>
    <div class="post-row">
      <a href="/board/read.php?uid=77">Scholarship Selection Announcement 2026.07.07</a>
    </div>
  </main>
`;
const anchorRecovered = parseNoticeList(
  { ...baseSource, listItemSelector: "", titleSelector: "", noticeUrlPattern: "" },
  anchorFallbackHtml,
);
assert.equal(anchorRecovered.items.length, 1);
assert.equal(anchorRecovered.metrics.parserStrategy, LIST_PARSER_STRATEGIES.HEURISTIC_ANCHOR);
assert.equal(anchorRecovered.items[0].noticeUrl, "https://example.edu/board/read.php?uid=77");

const skkuBoardList = parseNoticeList(
  { ...baseSource, listItemSelector: "tbody tr", titleSelector: "", noticeUrlPattern: "mode=view" },
  `<div class="board list">
    <ul class="board-search-tab">
      <li><a href="?mode=list&boardId=1">학사공지(학생용)</a></li>
      <li><a href="?mode=list&boardId=2">장학</a></li>
    </ul>
    <div class="board-name-list board-wrap">
      <ul class="board-list-wrap">
        <li>
          <span>[장학]</span>
          <a href="?mode=view&viewBoardId=2&itemId=159727">2026학년도 장학금 신청 안내</a>
          <span>2026-06-05</span>
        </li>
      </ul>
    </div>
  </div>`,
);
assert.equal(skkuBoardList.items.length, 1);
assert.equal(skkuBoardList.metrics.parserStrategy, LIST_PARSER_STRATEGIES.COMMON_BOARD);
assert.equal(skkuBoardList.items[0].title, "2026학년도 장학금 신청 안내");

const categoryLinks = parseNoticeList(
  { ...baseSource, listItemSelector: "", titleSelector: "", noticeUrlPattern: "" },
  `<main>
    <a href="/user/main/view.do">메인으로 이동</a>
    <a href="/scholarship/list.do">장학안내</a>
    <a href="/user/main/view.do">VIEW MORE</a>
  </main>`,
);
assert.equal(categoryLinks.items.length, 0);

const detail = parseNoticeDetail(
  { ...baseSource, detailContentSelector: ".view-content", detailDateSelector: ".date" },
  `
    <html><head><title>Scholarship Selection Announcement</title></head><body>
      <nav><img src="/assets/logo.png" alt="logo"></nav>
      <article class="view-content">
        <h1>Scholarship Selection Announcement</h1>
        <p class="date">2026.07.07</p>
        <p>Students can apply for this scholarship by submitting the required documents before the announced deadline.</p>
        <figure>
          <img data-src="/uploads/poster.jpg" alt="Scholarship poster">
          <figcaption>Application schedule</figcaption>
        </figure>
      </article>
    </body></html>
  `,
  "https://example.edu/notice/42",
);
assert.equal(detail.title, "Scholarship Selection Announcement");
assert.ok(detail.content.includes("required documents"));
assert.equal(detail.detailDate, "2026.07.07");
assert.equal(detail.images.length, 1);
assert.equal(detail.images[0].url, "https://example.edu/uploads/poster.jpg");
assert.equal(detail.images[0].caption, "Application schedule");
assert.equal(detail.images[0].sourceAttribute, "data-src");

const khuDetail = parseNoticeDetail(
  baseSource,
  `<html><head><title>경희대학교 학생광장 공지사항</title></head><body>
    <article class="bbs-view">
      <header class="top"><h2 class="t">[장학] 2026-2학기 교내장학 신청 안내</h2></header>
      <div class="view-content"><p>교내장학 신청 대상과 제출 서류를 안내합니다.</p></div>
    </article>
  </body></html>`,
  "https://example.edu/view.do?boardId=1",
  { expectedTitle: "공통 2026-2학기 교내장학 신청 안내" },
);
assert.equal(khuDetail.title, "[장학] 2026-2학기 교내장학 신청 안내");

const koreanPlatformDetail = parseNoticeDetail(
  baseSource,
  `<html><head>
    <title>공지사항 &gt; 학부 게시판읽기 ( 2026학년도 장학금 신청 안내 ) | 예시대학교</title>
  </head><body>
    <h1>공지사항</h1>
    <div class="board-view-title-wrap"><h4><span>[장학]</span> 2026학년도 장학금 신청 안내</h4></div>
    <div class="article-text"><p>신청 대상과 제출 서류 및 접수 기간을 상세히 안내합니다.</p></div>
  </body></html>`,
  "https://example.edu/board.do?mode=view&articleNo=12",
);
assert.ok(koreanPlatformDetail.titleCandidates.includes("[장학] 2026학년도 장학금 신청 안내"));
assert.ok(koreanPlatformDetail.titleCandidates.includes("2026학년도 장학금 신청 안내"));
assert.equal(koreanPlatformDetail.bodySelector, ".article-text");

const labeledTableDetail = parseNoticeDetail(
  baseSource,
  `<table class="t_view">
    <tr><th>제목</th><td>교외 장학생 선발 공고</td></tr>
  </table>
  <div class="article-text"><p>지원 자격과 제출 방법을 확인하시기 바랍니다.</p></div>`,
  "https://example.edu/view.do?articleNo=13",
);
assert.equal(labeledTableDetail.title, "교외 장학생 선발 공고");

console.log("crawler_parser_tests=passed");
