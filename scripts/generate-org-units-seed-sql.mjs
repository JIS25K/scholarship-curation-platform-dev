import fs from "node:fs";
import path from "node:path";

const DEFAULT_CSV_PATH = "data/notice-sources.csv";
const DEFAULT_OUTPUT_PATH = "sql/drafts/prepare-org-units-for-crawler-targets.review.sql";
const SEED_MARKER = "crawler_csv_seed_p0_pre_ingest";
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
];
const SAMPLE_SOURCE_TARGETS = [
  { source_key: "cau_001", org_unit_id: 719 },
  { source_key: "cau_002", org_unit_id: 720 },
  { source_key: "yonsei_060", org_unit_id: 46 },
];

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
      get(columnName) {
        return cleanText(row[index[columnName]]);
      },
    }));

  return { absolutePath, header: normalizedHeader, rows };
}

function parseOrgUnitId(value) {
  const raw = cleanText(value);
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== "" && value !== null && value !== undefined))];
}

function groupBy(values, keyFn) {
  const groups = new Map();
  for (const value of values) {
    const key = keyFn(value);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
  return groups;
}

function sqlString(value) {
  if (value === null || value === undefined || value === "") return "null";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlJson(value) {
  return `${sqlString(JSON.stringify(value))}::jsonb`;
}

function normalizeUnitType(sourceLevels) {
  const levels = new Set(sourceLevels.map((level) => cleanText(level).toLowerCase()).filter(Boolean));
  if (levels.size === 1) {
    const [only] = levels;
    if (["university", "college", "division", "department"].includes(only)) return only;
  }
  if (levels.has("university")) return "university";
  if (levels.has("college")) return "college";
  if (levels.has("division")) return "division";
  return "department";
}

function chooseName(group) {
  const departmentNames = unique(group.rows.map((row) => row.get("department_name")));
  if (departmentNames.length === 1) return departmentNames[0];

  const collegeNames = unique(group.rows.map((row) => row.get("college_name")));
  if (collegeNames.length === 1) return collegeNames[0];

  const sourceNames = unique(group.rows.map((row) => row.get("source_name")));
  if (sourceNames.length === 1) return sourceNames[0];
  if (sourceNames.length > 1) return `${sourceNames[0]} 외 ${sourceNames.length - 1}`;

  return `csv-org-unit-${group.org_unit_id}`;
}

function buildInventory(rows) {
  const validRows = [];
  const invalidRows = [];
  const missingRows = [];

  for (const row of rows) {
    const raw = row.get("org_unit_id");
    if (!raw) {
      missingRows.push(row);
      continue;
    }

    const orgUnitId = parseOrgUnitId(raw);
    if (orgUnitId === null) {
      invalidRows.push(row);
      continue;
    }

    validRows.push({ row, orgUnitId });
  }

  const groupsByOrgUnit = new Map();
  for (const item of validRows) {
    if (!groupsByOrgUnit.has(item.orgUnitId)) {
      groupsByOrgUnit.set(item.orgUnitId, { org_unit_id: item.orgUnitId, rows: [] });
    }
    groupsByOrgUnit.get(item.orgUnitId).rows.push(item.row);
  }

  const sharedByUrl = new Map();
  for (const row of rows) {
    const listUrl = row.get("list_url");
    if (!listUrl) continue;
    if (!sharedByUrl.has(listUrl)) sharedByUrl.set(listUrl, []);
    sharedByUrl.get(listUrl).push(row);
  }
  const sharedGroups = [...sharedByUrl.values()].filter((groupRows) => groupRows.length > 1);
  const sharedMultiOrgGroups = sharedGroups.filter((groupRows) => {
    const orgUnitIds = unique(groupRows.map((row) => parseOrgUnitId(row.get("org_unit_id"))));
    return orgUnitIds.length > 1;
  });

  return {
    rows: rows.length,
    rowsWithOrgUnitId: validRows.length,
    missingOrgUnitId: missingRows.length,
    invalidOrgUnitId: invalidRows.length,
    uniqueOrgUnitId: groupsByOrgUnit.size,
    duplicateOrgUnitGroups: [...groupsByOrgUnit.values()].filter((group) => group.rows.length > 1).length,
    sourceLevelDistribution: Object.fromEntries(
      [...groupBy(rows, (row) => row.get("source_level") || "(blank)").entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([level, levelRows]) => [level, levelRows.length]),
    ),
    sampleIdsPresent: Object.fromEntries(
      [46, 719, 720].map((id) => [id, groupsByOrgUnit.has(id)]),
    ),
    sharedBoardGroupCount: sharedGroups.length,
    sharedBoardMultiOrgGroupCount: sharedMultiOrgGroups.length,
    groups: [...groupsByOrgUnit.values()].sort((left, right) => left.org_unit_id - right.org_unit_id),
    validRows,
  };
}

function toSeedRow(group) {
  const sourceKeys = unique(group.rows.map((row) => row.get("source_id")));
  const sourceLevels = unique(group.rows.map((row) => row.get("source_level")));
  const metadata = {
    [SEED_MARKER]: {
      generated_from: "data/notice-sources.csv",
      org_unit_id: group.org_unit_id,
      source_keys: sourceKeys,
      source_levels: sourceLevels,
      university_slugs: unique(group.rows.map((row) => row.get("university_slug"))),
      university_ids: unique(group.rows.map((row) => row.get("university_id"))),
      college_ids: unique(group.rows.map((row) => row.get("college_id"))),
      department_ids: unique(group.rows.map((row) => row.get("department_id"))),
      college_names: unique(group.rows.map((row) => row.get("college_name"))),
      department_names: unique(group.rows.map((row) => row.get("department_name"))),
      source_names: unique(group.rows.map((row) => row.get("source_name"))),
      row_numbers: group.rows.map((row) => row.row_number),
      provisional: true,
    },
  };

  return {
    id: group.org_unit_id,
    unitType: normalizeUnitType(sourceLevels),
    name: chooseName(group),
    metadata,
  };
}

function formatValues(rows, formatter) {
  return rows.map((row, index) => `    ${formatter(row)}${index === rows.length - 1 ? "" : ","}`).join("\n");
}

function buildRequiredSourceTargets(rows) {
  return rows
    .map(({ row, orgUnitId }) => ({
      source_key: row.get("source_id"),
      org_unit_id: orgUnitId,
    }))
    .filter((row) => row.source_key)
    .sort((left, right) => left.source_key.localeCompare(right.source_key));
}

function buildSql(inventory, csvPath) {
  const seedRows = inventory.groups.map(toSeedRow);
  const requiredSourceTargets = buildRequiredSourceTargets(inventory.validRows);
  const requiredOrgUnitValues = formatValues(seedRows, (row) => `(${row.id}::bigint)`);
  const sourceTargetValues = formatValues(
    requiredSourceTargets,
    (row) => `(${sqlString(row.source_key)}, ${row.org_unit_id}::bigint)`,
  );
  const seedValues = formatValues(
    seedRows,
    (row) =>
      `(${row.id}::bigint, ${sqlString(row.unitType)}::public.org_unit_type, ${sqlString(row.name)}, ${sqlJson(
        row.metadata,
      )})`,
  );

  return `-- personal dev DB only
-- review draft only; this is not a migration
-- do not run against production
-- do not run without human approval
-- generated from ${csvPath.replaceAll("\\", "/")}
-- default transaction ends with rollback;
-- To apply after review, replace the final rollback; with commit;

begin;

-- A. Precheck -------------------------------------------------------------

select
  column_name,
  data_type,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'org_units'
order by ordinal_position;

select count(*) as org_units_row_count
from public.org_units;

with sample_sources(source_key, org_unit_id) as (
  values
    ('cau_001', 719::bigint),
    ('cau_002', 720::bigint),
    ('yonsei_060', 46::bigint)
)
select
  ss.source_key,
  cns.id as source_id,
  ss.org_unit_id,
  ou.id as existing_org_unit_id,
  (cns.id is not null) as source_exists,
  (ou.id is not null) as org_unit_exists
from sample_sources ss
left join public.crawler_notice_sources cns
  on cns.source_key = ss.source_key
left join public.org_units ou
  on ou.id = ss.org_unit_id
order by ss.source_key;

select count(*) as crawler_source_targets_row_count
from public.crawler_source_targets;

select
  column_name,
  data_type,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'crawler_source_targets'
order by ordinal_position;

with sample_org_units(org_unit_id) as (
  values (46::bigint), (719::bigint), (720::bigint)
)
select
  sou.org_unit_id,
  (ou.id is not null) as org_unit_exists
from sample_org_units sou
left join public.org_units ou
  on ou.id = sou.org_unit_id
order by sou.org_unit_id;

-- B. Minimal schema preparation -----------------------------------------
-- Minimal, additive-only preparation for the current id-only compatibility stub.
-- This intentionally avoids profiles, scholarships, matching functions, and full Phase1 backfill.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'org_unit_type') then
    create type public.org_unit_type as enum
      ('university', 'college', 'division', 'department');
  end if;
end $$;

alter table public.org_units
  add column if not exists parent_id bigint null references public.org_units(id) on delete restrict,
  add column if not exists unit_type public.org_unit_type null,
  add column if not exists name text null,
  add column if not exists path_ids bigint[] not null default '{}',
  add column if not exists field_code text null,
  add column if not exists legacy_table text null,
  add column if not exists legacy_id bigint null,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now();

create unique index if not exists uq_org_units_legacy
  on public.org_units (legacy_table, legacy_id)
  where legacy_table is not null;

create index if not exists idx_org_units_parent_id
  on public.org_units (parent_id);

create index if not exists idx_org_units_path_ids
  on public.org_units using gin (path_ids);

-- C. Seed marker strategy ------------------------------------------------
-- Use org_units.metadata->'${SEED_MARKER}' as the seed marker.
-- This keeps provenance on each provisional row, avoids a second registry table
-- for a temporary personal-dev seed, and supports safe marker-based cleanup.

-- D. CSV-based explicit ID seed -----------------------------------------
-- CSV inventory:
-- rows=${inventory.rows}
-- rows_with_org_unit_id=${inventory.rowsWithOrgUnitId}
-- unique_org_unit_id=${inventory.uniqueOrgUnitId}
-- invalid_org_unit_id=${inventory.invalidOrgUnitId}
-- duplicate_org_unit_groups=${inventory.duplicateOrgUnitGroups}

with csv_seed(id, unit_type, name, metadata) as (
  values
${seedValues}
)
insert into public.org_units (
  id,
  parent_id,
  unit_type,
  name,
  path_ids,
  legacy_table,
  legacy_id,
  metadata
)
overriding system value
select
  id,
  null,
  unit_type,
  name,
  array[id],
  'notice_sources_csv',
  id,
  metadata
from csv_seed
on conflict (id) do update
set
  unit_type = coalesce(public.org_units.unit_type, excluded.unit_type),
  name = coalesce(public.org_units.name, excluded.name),
  path_ids = case
    when public.org_units.path_ids = '{}'::bigint[] then excluded.path_ids
    else public.org_units.path_ids
  end,
  legacy_table = coalesce(public.org_units.legacy_table, excluded.legacy_table),
  legacy_id = coalesce(public.org_units.legacy_id, excluded.legacy_id),
  metadata = coalesce(public.org_units.metadata, '{}'::jsonb)
    || jsonb_build_object('${SEED_MARKER}', excluded.metadata -> '${SEED_MARKER}');

-- E. Verification --------------------------------------------------------

with required_org_units(org_unit_id) as (
  values
${requiredOrgUnitValues}
)
select
  count(*) as required_org_unit_ids,
  count(ou.id) as existing_org_unit_ids,
  count(*) - count(ou.id) as missing_org_unit_ids
from required_org_units rou
left join public.org_units ou
  on ou.id = rou.org_unit_id;

with required_org_units(org_unit_id) as (
  values
${requiredOrgUnitValues}
)
select rou.org_unit_id as missing_org_unit_id
from required_org_units rou
left join public.org_units ou
  on ou.id = rou.org_unit_id
where ou.id is null
order by rou.org_unit_id;

with sample_org_units(org_unit_id) as (
  values (46::bigint), (719::bigint), (720::bigint)
)
select
  sou.org_unit_id,
  (ou.id is not null) as org_unit_exists,
  (ou.metadata ? '${SEED_MARKER}') as has_seed_marker
from sample_org_units sou
left join public.org_units ou
  on ou.id = sou.org_unit_id
order by sou.org_unit_id;

with sample_sources(source_key, org_unit_id) as (
  values
    ('cau_001', 719::bigint),
    ('cau_002', 720::bigint),
    ('yonsei_060', 46::bigint)
)
select
  ss.source_key,
  cns.id as source_id,
  ss.org_unit_id,
  (cns.id is not null and ou.id is not null) as ready_for_crawler_source_targets
from sample_sources ss
left join public.crawler_notice_sources cns
  on cns.source_key = ss.source_key
left join public.org_units ou
  on ou.id = ss.org_unit_id
order by ss.source_key;

with required_source_targets(source_key, org_unit_id) as (
  values
${sourceTargetValues}
)
select
  count(*) as candidate_source_targets,
  count(cns.id) as source_ready_rows,
  count(ou.id) as org_unit_ready_rows,
  count(*) filter (where cns.id is not null and ou.id is not null) as ready_rows
from required_source_targets rst
left join public.crawler_notice_sources cns
  on cns.source_key = rst.source_key
left join public.org_units ou
  on ou.id = rst.org_unit_id;

select count(*) as seed_marker_row_count
from public.org_units
where metadata ? '${SEED_MARKER}';

select count(*) as org_units_total_row_count
from public.org_units;

-- F. Cleanup / rollback --------------------------------------------------
-- Do not delete marker rows if crawler_source_targets or crawler_notice_targets
-- already reference them. Review dependent counts before changing rollback to commit.
-- Cleanup delete SQL is provided as a commented draft only. Do not run it in the
-- same transaction used to prepare seed rows.

select count(*) as seed_rows_referenced_by_crawler_source_targets
from public.org_units ou
join public.crawler_source_targets cst
  on cst.org_unit_id = ou.id
where ou.metadata ? '${SEED_MARKER}';

select count(*) as seed_rows_referenced_by_crawler_notice_targets
from public.org_units ou
join public.crawler_notice_targets cnt
  on cnt.org_unit_id = ou.id
where ou.metadata ? '${SEED_MARKER}';

-- Cleanup draft, for a separate reviewed transaction only:
--
-- delete from public.org_units ou
-- where ou.metadata ? '${SEED_MARKER}'
--   and not exists (
--     select 1
--     from public.crawler_source_targets cst
--     where cst.org_unit_id = ou.id
--   )
--   and not exists (
--     select 1
--     from public.crawler_notice_targets cnt
--     where cnt.org_unit_id = ou.id
--   );

rollback;
`;
}

function parseArgs(argv) {
  const options = {
    csvPath: DEFAULT_CSV_PATH,
    outputPath: DEFAULT_OUTPUT_PATH,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--csv") {
      if (!next) throw new Error("--csv requires a path.");
      options.csvPath = next;
      index += 1;
    } else if (arg === "--out") {
      if (!next) throw new Error("--out requires a path.");
      options.outputPath = next;
      index += 1;
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
  node scripts/generate-org-units-seed-sql.mjs [--csv data/notice-sources.csv] [--out sql/drafts/prepare-org-units-for-crawler-targets.review.sql]

Safety:
  Generates a review SQL draft only. No DB connection, no environment reads,
  no Supabase calls, and no writes outside the selected output file.
`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const { absolutePath, rows } = readCsvRows(options.csvPath);
  const inventory = buildInventory(rows);
  if (inventory.invalidOrgUnitId > 0 || inventory.missingOrgUnitId > 0) {
    throw new Error("Refusing to generate SQL: CSV has missing or invalid org_unit_id values.");
  }

  const outputPath = path.resolve(options.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buildSql(inventory, path.relative(process.cwd(), absolutePath)), "utf8");

  console.log("org_units_seed_sql_generation=ok");
  console.log(`output_path=${options.outputPath}`);
  console.log(`csv_rows=${inventory.rows}`);
  console.log(`rows_with_org_unit_id=${inventory.rowsWithOrgUnitId}`);
  console.log(`unique_org_unit_id=${inventory.uniqueOrgUnitId}`);
  console.log(`invalid_org_unit_id=${inventory.invalidOrgUnitId}`);
  console.log(`duplicate_org_unit_groups=${inventory.duplicateOrgUnitGroups}`);
  console.log(`shared_board_groups=${inventory.sharedBoardGroupCount}`);
  console.log(`shared_board_multi_org_groups=${inventory.sharedBoardMultiOrgGroupCount}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
