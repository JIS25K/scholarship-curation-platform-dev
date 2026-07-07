import fs from "node:fs";
import path from "node:path";

const inputPath = process.argv[2] ?? "data/notice-sources.csv";
const outputPath = process.argv[3] ?? inputPath;
const sourcePrefix = String(process.argv[4] ?? "").trim().toLowerCase();

const DEFAULT_KEYWORDS = "장학|장학금|학자금|등록금|scholarship|tuition|fellowship";
const DO_DETAIL_URL_PATTERN = "(mode=view|articleNo=|boardNo=|nttNo=|idx=|no=\\d+)";

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function toCsvCell(value) {
  const text = String(value ?? "");
  const escaped = text.replace(/"/g, "\"\"");
  if (/[",\n\r]/.test(escaped)) return `"${escaped}"`;
  return escaped;
}

function cleanText(value) {
  return String(value ?? "").trim();
}

const raw = fs.readFileSync(path.resolve(inputPath), "utf8").replace(/^\uFEFF/, "");
const table = parseCsv(raw);
if (table.length === 0) throw new Error("Input CSV is empty.");

const [header, ...body] = table;
const index = Object.fromEntries(header.map((name, i) => [name, i]));

const requiredColumns = [
  "source_id",
  "list_url",
  "list_item_selector",
  "link_selector",
  "title_selector",
  "date_selector",
  "notice_url_pattern",
  "keywords",
];
for (const column of requiredColumns) {
  if (!(column in index)) throw new Error(`Missing column: ${column}`);
}

let tunedCount = 0;
const outputRows = body.map((row) => {
  const next = [...row];
  const sourceId = cleanText(next[index.source_id]).toLowerCase();
  if (sourcePrefix && !sourceId.startsWith(sourcePrefix)) return next;

  const listUrl = cleanText(next[index.list_url]).toLowerCase();

  if (!cleanText(next[index.keywords])) {
    next[index.keywords] = DEFAULT_KEYWORDS;
    tunedCount += 1;
  }

  const isDoBoard = listUrl.includes(".do");
  if (isDoBoard) {
    if (!cleanText(next[index.list_item_selector])) {
      next[index.list_item_selector] = "tbody tr";
      tunedCount += 1;
    }
    if (!cleanText(next[index.link_selector])) {
      next[index.link_selector] = "a[href]";
      tunedCount += 1;
    }
    if (!cleanText(next[index.title_selector])) {
      next[index.title_selector] = "a[href]";
      tunedCount += 1;
    }
    const existingDateSelector = cleanText(next[index.date_selector]);
    if (!existingDateSelector || existingDateSelector === "td") {
      next[index.date_selector] = "td:last-child, .date, .board-date, .wr_date";
      tunedCount += 1;
    }
    if (!cleanText(next[index.notice_url_pattern])) {
      next[index.notice_url_pattern] = DO_DETAIL_URL_PATTERN;
      tunedCount += 1;
    }
  } else {
    if (!cleanText(next[index.link_selector])) {
      next[index.link_selector] = "a[href]";
      tunedCount += 1;
    }
  }

  return next;
});

const lines = [
  header.map(toCsvCell).join(","),
  ...outputRows.map((row) => row.map(toCsvCell).join(",")),
];

const resolvedOutput = path.resolve(outputPath);
fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
fs.writeFileSync(resolvedOutput, `${lines.join("\r\n")}\r\n`, "utf8");

console.log(`rows=${body.length}`);
console.log(`tuned_fields=${tunedCount}`);
console.log(`prefix=${sourcePrefix || "all"}`);
console.log(`output=${resolvedOutput}`);
