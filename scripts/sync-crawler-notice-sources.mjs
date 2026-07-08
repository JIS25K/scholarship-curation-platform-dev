import fs from "node:fs";
import path from "node:path";

const DEFAULT_CSV_PATH = "data/notice-sources.csv";
const VALID_SOURCE_LEVELS = new Set(["university", "college", "division", "department"]);
const REQUIRED_COLUMNS = ["source_id", "source_name", "list_url", "source_level"];

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

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

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
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

function parseArgs(argv) {
  const options = {
    csvPath: DEFAULT_CSV_PATH,
    dryRun: true,
    apply: false,
    personalDevDbConfirmed: false,
    json: false,
    limit: 0,
    prefix: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--csv") {
      options.csvPath = next ?? "";
      index += 1;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--apply") {
      options.apply = true;
      options.dryRun = false;
    } else if (arg === "--yes-i-am-using-personal-dev-db") {
      options.personalDevDbConfirmed = true;
    } else if (arg === "--limit") {
      options.limit = Math.max(0, Number(next ?? 0));
      index += 1;
    } else if (arg === "--prefix") {
      options.prefix = cleanText(next).toLowerCase();
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/sync-crawler-notice-sources.mjs --csv data/notice-sources.csv --dry-run [--limit N] [--prefix PREFIX] [--json]

Options:
  --csv PATH                         Source CSV path. Defaults to data/notice-sources.csv.
  --dry-run                          Preview validation and crawler_notice_sources payloads. Default.
  --limit N                          Limit selected rows after prefix filtering.
  --prefix PREFIX                    Select source_key values that start with PREFIX.
  --json                             Print machine-readable JSON only.
  --apply                            Reserved for a later P0 step; intentionally disabled now.
  --yes-i-am-using-personal-dev-db   Reserved apply safety confirmation.
`);
}

function readCsvRows(csvPath) {
  const absolutePath = path.resolve(csvPath);
  const raw = fs.readFileSync(absolutePath, "utf8").replace(/^\uFEFF/, "");
  const table = parseCsv(raw);
  if (table.length === 0) throw new Error(`CSV is empty: ${csvPath}`);

  const [header, ...body] = table;
  const normalizedHeader = header.map(cleanText);
  const index = Object.fromEntries(normalizedHeader.map((name, columnIndex) => [name, columnIndex]));
  const missingColumns = REQUIRED_COLUMNS.filter((column) => !(column in index));
  if (missingColumns.length > 0) {
    throw new Error(`Missing required CSV columns: ${missingColumns.join(", ")}`);
  }

  const rows = body
    .filter((row) => row.some((cell) => cleanText(cell)))
    .map((row, rowIndex) => ({
      rowNumber: rowIndex + 2,
      raw: row,
      get(columnName) {
        return cleanText(row[index[columnName]]);
      },
    }));

  return { absolutePath, header: normalizedHeader, index, rows };
}

function parseList(value) {
  if (!value) return [];
  return String(value)
    .split("|")
    .map((piece) => cleanText(piece))
    .filter(Boolean);
}

function toBoolean(value, defaultValue = true) {
  const normalized = cleanText(value).toLowerCase();
  if (!normalized) return defaultValue;
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  return defaultValue;
}

function deriveUniversitySlug(sourceKey, explicitSlug) {
  const normalizedExplicitSlug = cleanText(explicitSlug).toLowerCase();
  if (normalizedExplicitSlug) return normalizedExplicitSlug;

  const normalizedSourceKey = cleanText(sourceKey).toLowerCase();
  if (normalizedSourceKey.includes("_")) return normalizedSourceKey.split("_")[0];
  return "";
}

function getOptional(row, columnName, index) {
  if (!(columnName in index)) return "";
  return row.get(columnName);
}

function isValidAbsoluteHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function compactObject(value) {
  if (Array.isArray(value)) {
    const compacted = value.map(compactObject).filter((item) => item !== undefined);
    return compacted.length > 0 ? compacted : undefined;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .map(([key, item]) => [key, compactObject(item)])
      .filter(([, item]) => item !== undefined);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }

  if (value === "" || value === null || value === undefined) return undefined;
  return value;
}

function toCrawlerNoticeSourcePayload(row, index) {
  const sourceKey = row.get("source_id");
  const sourceLevel = row.get("source_level").toLowerCase();
  const configuredUrl = row.get("list_url");
  const baseUrl = getOptional(row, "base_url", index);
  const adapterCode = getOptional(row, "adapter", index);
  const keywords = parseList(getOptional(row, "keywords", index));

  const parserConfig =
    compactObject({
      selectors: {
        list_item: getOptional(row, "list_item_selector", index),
        link: getOptional(row, "link_selector", index),
        title: getOptional(row, "title_selector", index),
        date: getOptional(row, "date_selector", index),
        detail_content: getOptional(row, "detail_content_selector", index),
        detail_date: getOptional(row, "detail_date_selector", index),
      },
      notice_url_pattern: getOptional(row, "notice_url_pattern", index),
      keywords,
      csv_metadata: {
        university_id: getOptional(row, "university_id", index),
        college_id: getOptional(row, "college_id", index),
        department_id: getOptional(row, "department_id", index),
        org_unit_id: getOptional(row, "org_unit_id", index),
        college_name: getOptional(row, "college_name", index),
        department_name: getOptional(row, "department_name", index),
      },
    }) ?? {};

  return {
    source_key: sourceKey,
    university_slug: deriveUniversitySlug(sourceKey, getOptional(row, "university_slug", index)) || null,
    source_level: sourceLevel,
    source_name: row.get("source_name"),
    configured_url: configuredUrl,
    effective_url: null,
    base_url: baseUrl || null,
    parser_config: parserConfig,
    adapter_code: adapterCode || null,
    enabled: toBoolean(getOptional(row, "enabled", index), true),
    health: {},
  };
}

function collectDuplicateSourceKeys(rows) {
  const counts = new Map();
  for (const row of rows) {
    const sourceKey = row.get("source_id");
    if (!sourceKey) continue;
    if (!counts.has(sourceKey)) counts.set(sourceKey, []);
    counts.get(sourceKey).push(row.rowNumber);
  }
  return [...counts.entries()]
    .filter(([, rowNumbers]) => rowNumbers.length > 1)
    .map(([sourceKey, rowNumbers]) => ({ sourceKey, rowNumbers }));
}

function validateRows(rows, index) {
  const missingRequiredFields = [];
  const invalidUrls = [];
  const invalidBaseUrls = [];
  const invalidSourceLevels = [];

  for (const row of rows) {
    for (const field of REQUIRED_COLUMNS) {
      if (!row.get(field)) {
        missingRequiredFields.push({
          rowNumber: row.rowNumber,
          sourceKey: row.get("source_id") || null,
          field,
        });
      }
    }

    const configuredUrl = row.get("list_url");
    if (configuredUrl && !isValidAbsoluteHttpUrl(configuredUrl)) {
      invalidUrls.push({
        rowNumber: row.rowNumber,
        sourceKey: row.get("source_id") || null,
        value: configuredUrl,
      });
    }

    const baseUrl = getOptional(row, "base_url", index);
    if (baseUrl && !isValidAbsoluteHttpUrl(baseUrl)) {
      invalidBaseUrls.push({
        rowNumber: row.rowNumber,
        sourceKey: row.get("source_id") || null,
        value: baseUrl,
      });
    }

    const sourceLevel = row.get("source_level").toLowerCase();
    if (sourceLevel && !VALID_SOURCE_LEVELS.has(sourceLevel)) {
      invalidSourceLevels.push({
        rowNumber: row.rowNumber,
        sourceKey: row.get("source_id") || null,
        value: sourceLevel,
      });
    }
  }

  return {
    missingRequiredFields,
    invalidUrls,
    invalidBaseUrls,
    invalidSourceLevels,
  };
}

function countEmptyFields(rows, fields) {
  return Object.fromEntries(
    fields.map((field) => [
      field,
      rows.filter((row) => !row.get(field)).length,
    ]),
  );
}

function buildDryRunResult(options) {
  const { absolutePath, header, index, rows } = readCsvRows(options.csvPath);
  const duplicateSourceKeys = collectDuplicateSourceKeys(rows);
  const validation = validateRows(rows, index);

  const prefix = cleanText(options.prefix).toLowerCase();
  const prefixFilteredRows = prefix
    ? rows.filter((row) => row.get("source_id").toLowerCase().startsWith(prefix))
    : rows;
  const selectedRows = options.limit > 0 ? prefixFilteredRows.slice(0, options.limit) : prefixFilteredRows;
  const samplePayloads = selectedRows
    .slice(0, 10)
    .map((row) => toCrawlerNoticeSourcePayload(row, index));

  const orgUnitCandidateRows = selectedRows.filter((row) => getOptional(row, "org_unit_id", index)).length;
  const sharedBoardCandidates = new Map();
  for (const row of rows) {
    const listUrl = row.get("list_url");
    if (!listUrl) continue;
    if (!sharedBoardCandidates.has(listUrl)) sharedBoardCandidates.set(listUrl, []);
    sharedBoardCandidates.get(listUrl).push(row.get("source_id"));
  }

  return {
    ok:
      duplicateSourceKeys.length === 0 &&
      validation.invalidUrls.length === 0 &&
      validation.invalidBaseUrls.length === 0 &&
      validation.invalidSourceLevels.length === 0 &&
      validation.missingRequiredFields.length === 0,
    mode: "dry-run",
    csvPath: absolutePath,
    csvRows: rows.length,
    selectedRows: selectedRows.length,
    samplePayloadCount: samplePayloads.length,
    prefix: prefix || null,
    limit: options.limit || null,
    plannedSourceUpserts: selectedRows.length,
    dbDiffAvailable: false,
    dbDiffReason: "No Supabase connection is used in P0-1 dry-run.",
    header,
    emptyFieldCounts: countEmptyFields(rows, [
      "source_id",
      "university_slug",
      "source_level",
      "source_name",
      "list_url",
      "base_url",
      "adapter",
      "org_unit_id",
    ]),
    duplicateSourceKeys,
    invalidUrls: validation.invalidUrls,
    invalidBaseUrls: validation.invalidBaseUrls,
    invalidSourceLevels: validation.invalidSourceLevels,
    missingRequiredFields: validation.missingRequiredFields,
    sourceTargetCandidateRows: orgUnitCandidateRows,
    sharedBoardCandidateCount: [...sharedBoardCandidates.values()].filter((sourceKeys) => sourceKeys.length > 1).length,
    samplePayloads,
  };
}

function printTextReport(result) {
  console.log("source_sync_dry_run=ok");
  console.log(`csv_rows=${result.csvRows}`);
  console.log(`selected_rows=${result.selectedRows}`);
  console.log(`planned_source_upserts=${result.plannedSourceUpserts}`);
  console.log(`duplicate_source_keys=${result.duplicateSourceKeys.length}`);
  console.log(`invalid_urls=${result.invalidUrls.length}`);
  console.log(`invalid_base_urls=${result.invalidBaseUrls.length}`);
  console.log(`invalid_source_levels=${result.invalidSourceLevels.length}`);
  console.log(`missing_required_fields=${result.missingRequiredFields.length}`);
  console.log(`source_target_candidate_rows=${result.sourceTargetCandidateRows}`);
  console.log(`shared_board_candidate_count=${result.sharedBoardCandidateCount}`);
  console.log(`db_diff_available=${result.dbDiffAvailable}`);
  console.log(`db_diff_reason=${result.dbDiffReason}`);
  console.log("sample_payloads=");
  console.log(JSON.stringify(result.samplePayloads, null, 2));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (options.apply) {
    throw new Error(
      "--apply is intentionally disabled for P0-1. Run this script in --dry-run mode only.",
    );
  }

  const result = buildDryRunResult(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printTextReport(result);
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`source_sync_dry_run=failed`);
  console.error(message);
  process.exitCode = 1;
}
