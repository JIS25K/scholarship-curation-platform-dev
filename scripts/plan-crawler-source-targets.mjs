import fs from "node:fs";
import path from "node:path";

const DEFAULT_CSV_PATH = "data/notice-sources.csv";
const REQUIRED_COLUMNS = ["source_id", "org_unit_id", "list_url"];
const MAX_APPLY_LIMIT = 10;

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
    checkDb: false,
    apply: false,
    personalDevDbConfirmed: false,
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
    } else if (arg === "--check-db") {
      options.checkDb = true;
    } else if (arg === "--apply") {
      options.apply = true;
      options.dryRun = false;
    } else if (arg === "--yes-i-am-using-personal-dev-db") {
      options.personalDevDbConfirmed = true;
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
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/plan-crawler-source-targets.mjs --csv data/notice-sources.csv --dry-run [--limit N] [--prefix PREFIX] [--source-key SOURCE_KEY] [--json]
  node scripts/plan-crawler-source-targets.mjs --apply --limit N (--prefix PREFIX | --source-key SOURCE_KEY) --yes-i-am-using-personal-dev-db

Options:
  --csv PATH              Source CSV path. Defaults to data/notice-sources.csv.
  --dry-run               CSV-only preview. Default and only supported mode in P0-3.
  --apply                 Guarded personal-dev upsert to crawler_source_targets.
                          Requires --limit N where N <= ${MAX_APPLY_LIMIT}, --prefix or --source-key,
                          --yes-i-am-using-personal-dev-db, PERSONAL_DEV_SUPABASE_CONFIRM=1,
                          SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY.
  --limit N               Limit selected rows after prefix/source-key filtering.
  --prefix PREFIX         Select source_key values that start with PREFIX.
  --source-key SOURCE_KEY Select exact source_key values. Can be repeated or comma-separated.
  --json                  Print machine-readable JSON only.
  --check-db              Read-only dev DB existence check for source_key and org_unit_id.
  --yes-i-am-using-personal-dev-db
                          Required with --check-db.

Safety:
  This script never reads .env and never prints URL/key values. CSV-only dry-run
  does not connect to Supabase. --check-db only reads
  crawler_notice_sources(source_key,id) and org_units(id), and requires explicit
  personal dev DB confirmation. --apply is capped to ${MAX_APPLY_LIMIT} selected rows
  and refuses to write unless every selected source and org_unit already exists.
  crawler_source_targets is treated as a composite-key table; no id column is assumed.
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
  const samplePayloads = readyPayloads.slice(0, 10);
  const sampleSharedBoardGroups = sharedBoards.multiOrgGroups.slice(0, 10);

  const result = {
    ok:
      invalidOrgUnitIds.length === 0 &&
      missingOrgUnitIds.length === 0 &&
      duplicateSourceOrgPairs.length === 0,
    mode: options.apply ? "apply" : options.checkDb ? "check-db" : "csv-only-dry-run",
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
    sample_payloads: samplePayloads,
    sample_shared_board_groups: sampleSharedBoardGroups,
    ready_to_sync: null,
    missing_sources: null,
    missing_org_units: null,
    csvRows: rows.length,
    selectedRows: selectedRows.length,
    candidateTargets: selectedRows.length,
    readyCsvOnly: readyPayloads.length,
    readyToSync: [],
    missingSources: [],
    missingOrgUnits: [],
    invalidOrgUnitIds: invalidOrgUnitIds.slice(0, 20),
    duplicateSourceOrgPairs: duplicateSourceOrgPairs.slice(0, 20),
    samplePayloads,
    sampleSharedBoardGroups,
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
        implemented: options.checkDb,
        reason: options.checkDb
          ? "Read-only check against crawler_notice_sources(source_key,id) and org_units(id)."
          : "Not requested; CSV-only mode does not import Supabase or read environment variables.",
      },
    },
  };

  Object.defineProperty(result, "_readyPayloads", {
    value: readyPayloads,
    enumerable: false,
  });

  return result;
}

function validateDbCheckOptions(options) {
  if (!options.checkDb) return;

  if (!options.personalDevDbConfirmed) {
    throw new Error("Refusing DB check: --yes-i-am-using-personal-dev-db is required.");
  }

  if (process.env.PERSONAL_DEV_SUPABASE_CONFIRM !== "1") {
    throw new Error("Refusing DB check: PERSONAL_DEV_SUPABASE_CONFIRM=1 is required.");
  }

  if (!process.env.SUPABASE_URL) {
    throw new Error("Refusing DB check: SUPABASE_URL is required.");
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Refusing DB check: SUPABASE_SERVICE_ROLE_KEY is required.");
  }
}

function validateApplyOptions(options) {
  if (!options.apply) return;

  if (!options.personalDevDbConfirmed) {
    throw new Error("Refusing apply: --yes-i-am-using-personal-dev-db is required.");
  }

  if (process.env.PERSONAL_DEV_SUPABASE_CONFIRM !== "1") {
    throw new Error("Refusing apply: PERSONAL_DEV_SUPABASE_CONFIRM=1 is required.");
  }

  if (!process.env.SUPABASE_URL) {
    throw new Error("Refusing apply: SUPABASE_URL is required.");
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Refusing apply: SUPABASE_SERVICE_ROLE_KEY is required.");
  }

  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_APPLY_LIMIT) {
    throw new Error(`Refusing apply: --limit is required and must be <= ${MAX_APPLY_LIMIT}.`);
  }

  if (!cleanText(options.prefix) && options.sourceKeys.length === 0) {
    throw new Error("Refusing apply: --prefix or --source-key is required.");
  }
}

function uniqueValues(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ""))];
}

async function loadRowsByIn(supabase, table, columns, columnName, values) {
  const unique = uniqueValues(values);
  const rows = [];
  const pageSize = 100;

  for (let index = 0; index < unique.length; index += pageSize) {
    const chunk = unique.slice(index, index + pageSize);
    const { data, error } = await supabase.from(table).select(columns).in(columnName, chunk);
    if (error) throw new Error(`DB read failed for ${table}: ${error.message}`);
    rows.push(...(data ?? []));
  }

  return rows;
}

async function addDbCheckResult(result, options) {
  if (options.checkDb) validateDbCheckOptions(options);

  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const readyPayloads = result._readyPayloads ?? [];
  const sourceKeys = uniqueValues(readyPayloads.map((payload) => payload.source_key));
  const orgUnitIds = uniqueValues(readyPayloads.map((payload) => payload.org_unit_id));

  const [sourceRows, orgUnitRows] = await Promise.all([
    loadRowsByIn(supabase, "crawler_notice_sources", "source_key,id", "source_key", sourceKeys),
    loadRowsByIn(supabase, "org_units", "id", "id", orgUnitIds),
  ]);

  const sourceIdByKey = new Map(sourceRows.map((row) => [row.source_key, row.id]));
  const orgUnitIdSet = new Set(orgUnitRows.map((row) => row.id));
  const readyToSync = [];
  const missingSources = [];
  const missingOrgUnits = [];

  for (const payload of readyPayloads) {
    const sourceId = sourceIdByKey.get(payload.source_key);
    if (!sourceId) {
      missingSources.push({
        source_key: payload.source_key,
        org_unit_id: payload.org_unit_id,
      });
      continue;
    }

    if (!orgUnitIdSet.has(payload.org_unit_id)) {
      missingOrgUnits.push({
        source_key: payload.source_key,
        source_id: sourceId,
        org_unit_id: payload.org_unit_id,
      });
      continue;
    }

    readyToSync.push({
      source_key: payload.source_key,
      source_id: sourceId,
      org_unit_id: payload.org_unit_id,
      priority: payload.priority,
    });
  }

  result.ready_to_sync = readyToSync.length;
  result.missing_sources = missingSources.length;
  result.missing_org_units = missingOrgUnits.length;
  result.readyToSync = readyToSync;
  result.missingSources = missingSources;
  result.missingOrgUnits = missingOrgUnits;
  result.sample_payloads = readyToSync.slice(0, 10);
  result.samplePayloads = result.sample_payloads;
  result.details.db_read_only_check = {
    implemented: true,
    executed: true,
    queried_tables: ["crawler_notice_sources", "org_units"],
    queried_columns: {
      crawler_notice_sources: ["source_key", "id"],
      org_units: ["id"],
    },
    writes_executed: false,
  };
}

function validateApplyReadiness(result) {
  if (!result.ok) {
    throw new Error("Refusing apply: CSV validation failed. Run dry-run and resolve reported issues first.");
  }

  if (result.readyToSync.length < 1) {
    throw new Error("Refusing apply: no ready source-target rows selected.");
  }

  if (result.missingSources.length > 0 || result.missingOrgUnits.length > 0) {
    throw new Error(
      `Refusing apply: missing_sources=${result.missingSources.length}, missing_org_units=${result.missingOrgUnits.length}.`,
    );
  }
}

async function applyCrawlerSourceTargets(result, options) {
  validateApplyOptions(options);
  validateApplyReadiness(result);

  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const payloads = result.readyToSync.map((row) => ({
    source_id: row.source_id,
    org_unit_id: row.org_unit_id,
    priority: row.priority,
  }));

  const { error } = await supabase
    .from("crawler_source_targets")
    .upsert(payloads, { onConflict: "source_id,org_unit_id" });

  if (error) {
    throw new Error(`crawler_source_targets upsert failed: ${error.message}`);
  }

  const sourceKeys = result.readyToSync.map((row) => row.source_key);
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "apply",
          applied_rows: payloads.length,
          source_keys: sourceKeys,
          writes_executed: true,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("source_targets_apply=ok");
  console.log(`applied_rows=${payloads.length}`);
  console.log(`source_keys=${sourceKeys.join(",")}`);
  console.log("writes_executed=true");
}

function printTextReport(result) {
  console.log("source_targets_dry_run=ok");
  console.log(`mode=${result.mode}`);
  console.log(`csv_rows=${result.csv_rows}`);
  console.log(`selected_rows=${result.selected_rows}`);
  console.log(`candidate_targets=${result.candidate_targets}`);
  console.log(`ready_csv_only=${result.ready_csv_only}`);
  if (result.ready_to_sync !== null) console.log(`ready_to_sync=${result.ready_to_sync}`);
  if (result.missing_sources !== null) console.log(`missing_sources=${result.missing_sources}`);
  if (result.missing_org_units !== null) console.log(`missing_org_units=${result.missing_org_units}`);
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

  if (options.apply) validateApplyOptions(options);
  validateDbCheckOptions(options);
  const result = buildPlan(options);
  if (options.checkDb || options.apply) {
    await addDbCheckResult(result, options);
  }

  if (options.apply) {
    await applyCrawlerSourceTargets(result, options);
    return;
  }

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
