import fs from "node:fs";
import path from "node:path";

const DEFAULT_CSV_PATH = "data/notice-sources.csv";
const REQUIRED_COLUMNS = ["source_id", "org_unit_id", "list_url"];

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    const next = text[index + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        index += 1;
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

function parseSourceKeyFilter(value) {
  return String(value ?? "")
    .split(/[,\s|]+/)
    .map((piece) => cleanText(piece).toLowerCase())
    .filter(Boolean);
}

function parseNonNegativeInteger(value, optionName) {
  const normalized = cleanText(value);
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${optionName} must be a non-negative integer.`);
  }
  return Number(normalized);
}

function parseArgs(argv) {
  const options = {
    csvPath: DEFAULT_CSV_PATH,
    dryRun: true,
    json: false,
    limit: 0,
    prefix: "",
    sourceKeys: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--csv") {
      if (!next) throw new Error("--csv requires a path.");
      options.csvPath = next;
      index += 1;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--limit") {
      if (!next) throw new Error("--limit requires a value.");
      options.limit = parseNonNegativeInteger(next, "--limit");
      index += 1;
    } else if (arg === "--prefix") {
      if (!next) throw new Error("--prefix requires a value.");
      options.prefix = cleanText(next).toLowerCase();
      index += 1;
    } else if (arg === "--source-key") {
      if (!next) throw new Error("--source-key requires a value.");
      options.sourceKeys.push(...parseSourceKeyFilter(next));
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--apply" || arg === "--check-db") {
      throw new Error(`${arg} is intentionally not implemented in P0-3 CSV-only dry-run.`);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/plan-crawler-source-targets.mjs --csv data/notice-sources.csv --dry-run [--limit N] [--prefix PREFIX] [--source-key SOURCE_KEY] [--json]

Options:
  --csv PATH              Source CSV path. Defaults to data/notice-sources.csv.
  --dry-run               CSV-only preview. Default and only supported mode in P0-3.
  --limit N               Limit selected rows after prefix/source-key filtering.
  --prefix PREFIX         Select source_key values that start with PREFIX.
  --source-key SOURCE_KEY Select exact source_key values. Can be repeated or comma-separated.
  --json                  Print machine-readable JSON only.

P0-3 safety:
  This script does not connect to Supabase, does not read .env, and does not write to DB.
  Payload previews use source_key. Real crawler_source_targets writes require
  crawler_notice_sources.source_key -> crawler_notice_sources.id lookup first.
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
      row_number: rowIndex + 2,
      raw: row,
      get(columnName) {
        return cleanText(row[index[columnName]]);
      },
    }));

  return { absolutePath, header: normalizedHeader, index, rows };
}

function parseOrgUnitId(value) {
  const raw = cleanText(value);
  if (!raw) return { ok: false, missing: true, raw, value: null };
  if (!/^\d+$/.test(raw)) return { ok: false, missing: false, raw, value: null };

  const valueNumber = Number(raw);
  if (!Number.isSafeInteger(valueNumber) || valueNumber <= 0) {
    return { ok: false, missing: false, raw, value: null };
  }

  return { ok: true, missing: false, raw, value: valueNumber };
}

function buildSelectedRows(rows, options) {
  const prefix = cleanText(options.prefix).toLowerCase();
  const sourceKeyFilter = new Set(options.sourceKeys);
  const prefixFilteredRows = prefix
    ? rows.filter((row) => row.get("source_id").toLowerCase().startsWith(prefix))
    : rows;
  const filteredRows =
    sourceKeyFilter.size > 0
      ? prefixFilteredRows.filter((row) => sourceKeyFilter.has(row.get("source_id").toLowerCase()))
      : prefixFilteredRows;

  return options.limit > 0 ? filteredRows.slice(0, options.limit) : filteredRows;
}

function collectDuplicatePairs(rows) {
  const counts = new Map();
  for (const row of rows) {
    const sourceKey = row.get("source_id");
    const parsedOrgUnitId = parseOrgUnitId(row.get("org_unit_id"));
    if (!sourceKey || !parsedOrgUnitId.ok) continue;

    const key = `${sourceKey}\u0000${parsedOrgUnitId.value}`;
    if (!counts.has(key)) {
      counts.set(key, {
        source_key: sourceKey,
        org_unit_id: parsedOrgUnitId.value,
        row_numbers: [],
      });
    }
    counts.get(key).row_numbers.push(row.row_number);
  }

  return [...counts.values()].filter((entry) => entry.row_numbers.length > 1);
}

function collectSharedBoardGroups(rows) {
  const byListUrl = new Map();
  for (const row of rows) {
    const listUrl = row.get("list_url");
    if (!listUrl) continue;
    if (!byListUrl.has(listUrl)) byListUrl.set(listUrl, []);
    byListUrl.get(listUrl).push(row);
  }

  const groups = [...byListUrl.entries()]
    .filter(([, groupRows]) => groupRows.length > 1)
    .map(([listUrl, groupRows]) => {
      const orgUnitIds = [
        ...new Set(
          groupRows
            .map((row) => parseOrgUnitId(row.get("org_unit_id")))
            .filter((parsed) => parsed.ok)
            .map((parsed) => parsed.value),
        ),
      ];
      return {
        list_url: listUrl,
        row_count: groupRows.length,
        source_keys: groupRows.map((row) => row.get("source_id")).filter(Boolean),
        org_unit_ids: orgUnitIds,
        unique_org_unit_count: orgUnitIds.length,
      };
    });

  const multiOrgGroups = groups.filter((group) => group.unique_org_unit_count > 1);
  const sharedRows = groups.reduce((sum, group) => sum + group.row_count, 0);

  return { groups, multiOrgGroups, sharedRows };
}

function buildPlan(options) {
  const { absolutePath, header, rows } = readCsvRows(options.csvPath);
  const selectedRows = buildSelectedRows(rows, options);
  const duplicateSourceOrgPairs = collectDuplicatePairs(selectedRows);
  const duplicatePairKeys = new Set(
    duplicateSourceOrgPairs.map((pair) => `${pair.source_key}\u0000${pair.org_unit_id}`),
  );
  const invalidOrgUnitIds = [];
  const missingOrgUnitIds = [];
  const readyPayloads = [];

  for (const row of selectedRows) {
    const sourceKey = row.get("source_id");
    const parsedOrgUnitId = parseOrgUnitId(row.get("org_unit_id"));

    if (parsedOrgUnitId.missing) {
      missingOrgUnitIds.push({
        row_number: row.row_number,
        source_key: sourceKey || null,
      });
      continue;
    }

    if (!parsedOrgUnitId.ok) {
      invalidOrgUnitIds.push({
        row_number: row.row_number,
        source_key: sourceKey || null,
        raw_org_unit_id: parsedOrgUnitId.raw,
      });
      continue;
    }

    if (!sourceKey || duplicatePairKeys.has(`${sourceKey}\u0000${parsedOrgUnitId.value}`)) continue;

    readyPayloads.push({
      source_key: sourceKey,
      org_unit_id: parsedOrgUnitId.value,
      priority: 0,
    });
  }

  const sharedBoards = collectSharedBoardGroups(rows);

  return {
    ok:
      invalidOrgUnitIds.length === 0 &&
      missingOrgUnitIds.length === 0 &&
      duplicateSourceOrgPairs.length === 0,
    mode: "csv-only-dry-run",
    csv_path: absolutePath,
    csv_rows: rows.length,
    selected_rows: selectedRows.length,
    candidate_targets: selectedRows.length,
    ready_csv_only: readyPayloads.length,
    invalid_org_unit_ids: invalidOrgUnitIds.length,
    missing_org_unit_ids: missingOrgUnitIds.length,
    duplicate_source_org_pairs: duplicateSourceOrgPairs.length,
    classification_scope: "selected_rows",
    shared_board_scope: "all_csv_rows",
    shared_board_groups: sharedBoards.groups.length,
    shared_board_multi_org_groups: sharedBoards.multiOrgGroups.length,
    shared_board_rows: sharedBoards.sharedRows,
    sample_payloads: readyPayloads.slice(0, 10),
    sample_shared_board_groups: sharedBoards.multiOrgGroups.slice(0, 10),
    details: {
      header,
      prefix: cleanText(options.prefix) || null,
      source_keys: options.sourceKeys,
      limit: options.limit || null,
      invalid_org_unit_id_rows: invalidOrgUnitIds.slice(0, 20),
      missing_org_unit_id_rows: missingOrgUnitIds.slice(0, 20),
      duplicate_source_org_pair_rows: duplicateSourceOrgPairs.slice(0, 20),
      db_apply_note:
        "crawler_source_targets.source_id is bigint. P0-3 previews source_key only; apply must resolve crawler_notice_sources.source_key to crawler_notice_sources.id before insert/upsert.",
      shared_board_note:
        "Shared list_url groups are diagnostics only. P0-3 keeps the P0-1/P0-2 613 source_key model and does not collapse sources by URL.",
      db_read_only_check: {
        implemented: false,
        reason: "Deferred for P0-3; this script is CSV-only and does not import Supabase or read environment variables.",
      },
    },
  };
}

function printTextReport(result) {
  console.log("crawler_source_targets_plan=csv-only-dry-run");
  console.log(`csv_rows=${result.csv_rows}`);
  console.log(`selected_rows=${result.selected_rows}`);
  console.log(`candidate_targets=${result.candidate_targets}`);
  console.log(`ready_csv_only=${result.ready_csv_only}`);
  console.log(`invalid_org_unit_ids=${result.invalid_org_unit_ids}`);
  console.log(`missing_org_unit_ids=${result.missing_org_unit_ids}`);
  console.log(`duplicate_source_org_pairs=${result.duplicate_source_org_pairs}`);
  console.log(`shared_board_groups=${result.shared_board_groups}`);
  console.log(`shared_board_multi_org_groups=${result.shared_board_multi_org_groups}`);
  console.log(`shared_board_rows=${result.shared_board_rows}`);
  console.log(`classification_scope=${result.classification_scope}`);
  console.log(`shared_board_scope=${result.shared_board_scope}`);
  console.log("db_write_executed=false");
  console.log(`db_apply_note=${result.details.db_apply_note}`);
  console.log(`shared_board_note=${result.details.shared_board_note}`);
  console.log("sample_payloads=");
  console.log(JSON.stringify(result.sample_payloads, null, 2));
  console.log("sample_shared_board_groups=");
  console.log(JSON.stringify(result.sample_shared_board_groups, null, 2));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const result = buildPlan(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printTextReport(result);
  }

  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
