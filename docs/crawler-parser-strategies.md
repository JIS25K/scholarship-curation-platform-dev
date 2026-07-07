# Shared Crawler Parser Strategies

The production crawler and capability audit use the same parser modules under `lib/crawler-parsers`.
The audit evaluates parser output and evidence; it must not maintain a second HTML parser.

## List strategy order

1. `A_CONFIGURED_SELECTOR`
   - Uses the source CSV selectors exactly.
   - This is the most precise path when the source is tuned.
2. `B_COMMON_BOARD`
   - Tries common table, board-list, notice-list, card, and article structures.
   - Can recover valid board links when a generic configured URL pattern is stale.
   - Reconstructs common `view(id)` form navigation only when matching hidden form fields exist.
   - Supports Hanyang Liferay `viewMessage(id)` links through a platform URL adapter.
3. `C_HEURISTIC_ANCHOR`
   - Scans non-navigation anchors and event links.
   - Requires date, board metadata, a board-like container, or a detail-like URL.
   - Excludes header, navigation, footer, sidebar, and common menu labels.

The first strategy that returns accepted notice items wins. Every result records `parserStrategy`,
`parserRecovered`, selector counts, rejected URL-pattern counts, menu contamination, and URL evidence.

## Detail parsing

The shared detail parser returns:

- normalized title candidates
- body text and body HTML
- selected body selector and quality
- detail date when configured
- images contained inside the selected notice body

Image discovery supports `src`, `srcset`, `data-src`, `data-lazy-src`, and `data-original`. Relative
URLs are resolved against the final detail URL. Navigation images and 1-2 pixel trackers are excluded.
Downloading image bytes remains a separate responsibility from HTML parsing.

The list title is passed to the detail parser as an expected-title hint. It is used only to rank short
DOM title candidates; the audit still verifies the selected DOM text independently. Category/list URLs
and contaminated list cards are rejected before they can enter the final candidate set.

## Decision boundary

- A parser success does not automatically mean `supported`.
- `supported` still requires a fetched detail page, strong list/detail title identity, meaningful body
  text or body media, and no contaminated candidate leakage.
- Pagination evidence is recorded but is not a hard failure when the current notice page is crawlable.
- Items rejected only by scholarship keyword or date filters become `valid_zero_candidates`, not parser
  failures or manual-review requirements.
- JSON/XHR, browser-only navigation, authentication, CAPTCHA, and rate limiting remain adapter or manual
  review concerns.
