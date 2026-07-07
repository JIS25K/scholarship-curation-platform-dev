import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const CANONICAL_PATH = path.resolve(process.argv[2] ?? path.join(root, "data", "notice-sources.csv"));
const EXPECTED_PREFIXES = ["cau", "ewha", "hanyang", "hongik", "khu", "korea", "skku", "uos", "yonsei"];
const REQUIRED_COLUMNS = [
  "source_id",
  "university_slug",
  "university_id",
  "college_id",
  "department_id",
  "org_unit_id",
  "college_name",
  "department_name",
  "source_level",
  "source_name",
  "list_url",
  "base_url",
  "list_item_selector",
  "link_selector",
  "title_selector",
  "date_selector",
  "detail_content_selector",
  "detail_date_selector",
  "notice_url_pattern",
  "keywords",
  "adapter",
  "enabled",
];

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === "\"" && next === "\"") {
        field += "\"";
        i += 1;
      } else if (ch === "\"") {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === "\"") inQuotes = true;
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

function cleanText(value) {
  return String(value ?? "").trim();
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function loadCanonicalRows(csvPath) {
  const raw = readFileSync(csvPath, "utf8").replace(/^\uFEFF/, "");
  const table = parseCsv(raw);
  if (table.length === 0) throw new Error(`Source CSV is empty: ${csvPath}`);

  const [header, ...body] = table;
  const index = Object.fromEntries(header.map((name, i) => [name, i]));
  const rows = body
    .filter((cells) => cells.some((cell) => cleanText(cell)))
    .map((cells) => Object.fromEntries(header.map((name, i) => [name, cleanText(cells[i])])));

  return { header, index, rows };
}

const { header, index, rows } = loadCanonicalRows(CANONICAL_PATH);

for (const column of REQUIRED_COLUMNS) {
  if (!(column in index)) fail(`missing_required_column=${column}`);
}

const seenSourceIds = new Set();
const duplicateSourceIds = new Set();
const prefixCounts = Object.fromEntries(EXPECTED_PREFIXES.map((prefix) => [prefix, 0]));
const missingRequiredRows = [];

for (const row of rows) {
  const sourceId = cleanText(row.source_id);
  const prefix = sourceId.includes("_") ? sourceId.split("_")[0] : "";
  if (!sourceId || !row.source_name || !row.list_url) {
    missingRequiredRows.push(sourceId || "(blank)");
  }
  if (seenSourceIds.has(sourceId)) duplicateSourceIds.add(sourceId);
  seenSourceIds.add(sourceId);
  if (prefix in prefixCounts) prefixCounts[prefix] += 1;
}

if (duplicateSourceIds.size > 0) {
  fail(`duplicate_source_ids=${[...duplicateSourceIds].sort().join("|")}`);
}
if (missingRequiredRows.length > 0) {
  fail(`missing_required_row_values=${missingRequiredRows.slice(0, 20).join("|")}`);
}

const unexpectedPrefixes = [...new Set(rows.map((row) => cleanText(row.source_id).split("_")[0]))]
  .filter((prefix) => prefix && !EXPECTED_PREFIXES.includes(prefix))
  .sort();
if (unexpectedPrefixes.length > 0) {
  fail(`unexpected_prefixes=${unexpectedPrefixes.join("|")}`);
}

console.log(`canonical_source_config=${CANONICAL_PATH}`);
console.log(`rows=${rows.length}`);
console.log(`columns=${header.length}`);
console.log(`prefix_counts=${JSON.stringify(prefixCounts)}`);
console.log("mode=verify_only");
