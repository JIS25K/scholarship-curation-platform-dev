import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_FIXTURE_PATH = "fixtures/crawler-ingest-dry-run/sample-notices.json";
const SOURCE_CSV_PATH = "data/notice-sources.csv";
const DEFAULT_RULE_VERSION = "ingest-dry-run-v1";
const KEYWORDS = ["scholarship", "tuition", "fellowship", "장학", "장학금", "등록금"];
const VALID_ASSET_KINDS = new Set(["image", "attachment"]);

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parseArgs(argv) {
  const options = {
    fixturePath: DEFAULT_FIXTURE_PATH,
    sourceKey: "",
    limit: 0,
    json: false,
    outPath: "",
    checkDb: false,
    personalDevDbConfirmed: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--fixture") {
      if (!next) throw new Error("--fixture requires a path.");
      options.fixturePath = next;
      index += 1;
    } else if (arg === "--source-key") {
      if (!next) throw new Error("--source-key requires a value.");
      options.sourceKey = cleanText(next).toLowerCase();
      index += 1;
    } else if (arg === "--limit") {
      if (!next || !/^\d+$/.test(next)) throw new Error("--limit requires a non-negative integer.");
      options.limit = Number(next);
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--out") {
      if (!next) throw new Error("--out requires a path.");
      options.outPath = next;
      index += 1;
    } else if (arg === "--check-db") {
      options.checkDb = true;
    } else if (arg === "--yes-i-am-using-personal-dev-db") {
      options.personalDevDbConfirmed = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (["--apply", "--write", "--commit"].includes(arg)) {
      throw new Error(`${arg} is not supported. This dry-run script never writes to DB.`);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/ingest-crawler-run-dry-run.mjs --fixture fixtures/crawler-ingest-dry-run/sample-notices.json [--source-key cau_002] [--limit N] [--json] [--out reports/ingest-dry-run-sample.json]

Options:
  --fixture PATH          JSON fixture path. Defaults to ${DEFAULT_FIXTURE_PATH}.
  --source-key KEY        Limit processing to one source_key.
  --limit N               Limit total input items after source filtering.
  --json                  Print full JSON report.
  --out PATH              Save full JSON report to PATH.
  --check-db              Personal-dev read-only DB readiness check.
  --yes-i-am-using-personal-dev-db
                          Required with --check-db.

Safety:
  No DB writes, no .env loading, no crawler execution, and no apply/write/commit
  mode. --check-db only runs select queries after explicit personal-dev guards.
`);
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

function readSourceTargetMap(csvPath = SOURCE_CSV_PATH) {
  const raw = fs.readFileSync(path.resolve(csvPath), "utf8").replace(/^\uFEFF/, "");
  const table = parseCsv(raw);
  const [header, ...body] = table;
  const index = Object.fromEntries(header.map((name, columnIndex) => [cleanText(name), columnIndex]));
  for (const column of ["source_id", "org_unit_id"]) {
    if (!(column in index)) throw new Error(`Missing required CSV column: ${column}`);
  }

  const targetsBySourceKey = new Map();
  for (const row of body) {
    if (row.every((cell) => cleanText(cell) === "")) continue;
    const sourceKey = cleanText(row[index.source_id]).toLowerCase();
    const orgUnitIdRaw = cleanText(row[index.org_unit_id]);
    if (!sourceKey || !/^\d+$/.test(orgUnitIdRaw)) continue;
    const orgUnitId = Number(orgUnitIdRaw);
    if (!Number.isSafeInteger(orgUnitId) || orgUnitId <= 0) continue;
    if (!targetsBySourceKey.has(sourceKey)) targetsBySourceKey.set(sourceKey, []);
    targetsBySourceKey.get(sourceKey).push(orgUnitId);
  }

  return targetsBySourceKey;
}

function readFixture(fixturePath) {
  const resolved = path.resolve(fixturePath);
  if (!fs.existsSync(resolved)) throw new Error(`Fixture not found: ${fixturePath}`);
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!parsed || !Array.isArray(parsed.sources)) {
    throw new Error("Fixture must contain a sources array.");
  }
  return parsed;
}

function normalizeUrl(value) {
  const text = cleanText(value);
  if (!text) return "";
  try {
    const url = new URL(text);
    url.hash = "";
    return url.toString();
  } catch {
    return text;
  }
}

function hashText(value, length = 16) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

function toDateOrNull(value) {
  const text = cleanText(value);
  if (!text) return null;
  const head = text.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(head) ? head : null;
}

function toTimestampOrNull(value) {
  const text = cleanText(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function canonicalKeyFor(sourceKey, item) {
  const nativePostId = cleanText(item.native_post_id);
  if (nativePostId) return `${sourceKey}:native:${nativePostId}`;

  const canonicalUrl = normalizeUrl(item.canonical_url || item.final_url || item.discovered_url);
  if (canonicalUrl) return `${sourceKey}:url:${hashText(canonicalUrl, 20)}`;

  const title = cleanText(item.title).toLowerCase();
  const postedAt = toDateOrNull(item.published_at || item.posted_at) ?? "undated";
  return `${sourceKey}:title-date:${hashText(`${title}|${postedAt}`, 20)}`;
}

function contentHashFor(item) {
  return hashText(
    JSON.stringify({
      title: cleanText(item.title),
      posted_at: toDateOrNull(item.published_at || item.posted_at),
      body_text: cleanText(item.body_text ?? item.body),
    }),
    32,
  );
}

function makeOperation(operation, table, refs, payload) {
  return { operation, table, refs, payload };
}

function findKeywordMatches(noticeRef, item) {
  const matches = [];
  const fields = [
    ["title", cleanText(item.title)],
    ["body_text", cleanText(item.body_text ?? item.body)],
  ];

  for (const [field, text] of fields) {
    const lowered = text.toLowerCase();
    for (const keyword of KEYWORDS) {
      const index = lowered.indexOf(keyword.toLowerCase());
      if (index >= 0) {
        matches.push(
          makeOperation(
            "would_insert",
            "crawler_keyword_matches",
            { notice_ref: noticeRef },
            {
              rule_version: DEFAULT_RULE_VERSION,
              keyword,
              field,
              offset_start: index,
              offset_end: index + keyword.length,
              score: 1,
            },
          ),
        );
      }
    }
  }

  return matches;
}

function normalizeAssetKind(value) {
  const raw = cleanText(value || "attachment").toLowerCase();
  if (raw === "file") return "attachment";
  return VALID_ASSET_KINDS.has(raw) ? raw : "attachment";
}

function selectSources(fixture, options) {
  const sourceFilter = cleanText(options.sourceKey).toLowerCase();
  const selectedSources = sourceFilter
    ? fixture.sources.filter((source) => cleanText(source.source_key).toLowerCase() === sourceFilter)
    : fixture.sources;

  if (sourceFilter && selectedSources.length === 0) {
    throw new Error(`No fixture source found for --source-key ${sourceFilter}`);
  }

  let remaining = options.limit > 0 ? options.limit : Number.POSITIVE_INFINITY;
  return selectedSources.map((source) => {
    const items = Array.isArray(source.items) ? source.items : [];
    const selectedItems = items.slice(0, Math.max(0, remaining));
    remaining -= selectedItems.length;
    return { ...source, source_key: cleanText(source.source_key).toLowerCase(), items: selectedItems };
  });
}

function buildDryRunReport(fixture, options) {
  const targetsBySourceKey = readSourceTargetMap();
  const selectedSources = selectSources(fixture, options);
  const run = fixture.run ?? {};
  const runKey = cleanText(run.run_key) || `dry-run-${hashText(JSON.stringify(selectedSources), 12)}`;
  const runRef = `run:${runKey}`;
  const startedAt = toTimestampOrNull(run.started_at) ?? new Date(0).toISOString();
  const operations = {
    crawler_runs: [
      makeOperation("would_insert", "crawler_runs", { run_ref: runRef }, {
        started_at: startedAt,
        mode: cleanText(run.mode) || "manual",
        git_sha: cleanText(run.git_sha) || null,
        config_hash: cleanText(run.config_hash) || null,
        parser_version: cleanText(run.parser_version) || DEFAULT_RULE_VERSION,
        status: "succeeded",
        totals: {},
        metadata: {
          dry_run: true,
          fixture: path.normalize(options.fixturePath),
          run_key: runKey,
        },
      }),
    ],
    crawler_source_results: [],
    crawler_notices: [],
    crawler_notice_url_aliases: [],
    crawler_notice_occurrences: [],
    crawler_notice_targets: [],
    crawler_notice_assets: [],
    crawler_keyword_matches: [],
    crawler_errors: [],
  };
  const schemaBlockers = [];
  const skipped = [];
  const seenCanonicalKeys = new Map();
  const seenAliases = new Set();
  const seenTargets = new Set();
  const seenAssets = new Set();
  let inputItems = 0;

  for (const source of selectedSources) {
    const sourceKey = cleanText(source.source_key).toLowerCase();
    const sourceRef = `source:${sourceKey}`;
    const orgUnitIds = targetsBySourceKey.get(sourceKey) ?? [];
    if (orgUnitIds.length === 0) {
      schemaBlockers.push({
        source_key: sourceKey,
        blocker: "No org_unit_id mapping found in data/notice-sources.csv for source_key.",
      });
    }

    const sourceErrors = [];
    for (const [itemIndex, item] of source.items.entries()) {
      inputItems += 1;
      const title = cleanText(item.title);
      const discoveredUrl = normalizeUrl(item.discovered_url || item.notice_url || item.url);
      if (!title || !discoveredUrl) {
        skipped.push({
          source_key: sourceKey,
          item_index: itemIndex,
          reason: !title ? "missing_title" : "missing_discovered_url",
        });
        continue;
      }

      const canonicalKey = canonicalKeyFor(sourceKey, item);
      const noticeRef =
        seenCanonicalKeys.get(canonicalKey) ?? `notice:${seenCanonicalKeys.size + 1}`;
      const occurrenceRef = `occurrence:${sourceKey}:${itemIndex + 1}`;
      const canonicalUrl = normalizeUrl(item.canonical_url || item.final_url || discoveredUrl);
      const contentHash = contentHashFor(item);
      const postedAt = toDateOrNull(item.published_at || item.posted_at);

      if (!seenCanonicalKeys.has(canonicalKey)) {
        seenCanonicalKeys.set(canonicalKey, noticeRef);
        operations.crawler_notices.push(
          makeOperation("would_upsert", "crawler_notices", { notice_ref: noticeRef }, {
            canonical_key: canonicalKey,
            canonical_url: canonicalUrl || null,
            native_post_id: cleanText(item.native_post_id) || null,
            title,
            body_text: cleanText(item.body_text ?? item.body) || null,
            body_html: cleanText(item.body_html) || null,
            posted_at: postedAt,
            content_hash: contentHash,
            review_status: "new",
            scholarship_id: null,
            metadata: {
              dry_run: true,
              body_quality: cleanText(item.body_quality) || null,
              warnings: Array.isArray(item.warnings) ? item.warnings : [],
            },
          }),
        );
        operations.crawler_keyword_matches.push(...findKeywordMatches(noticeRef, item));
      }

      const aliasKey = `${noticeRef}\u0000${canonicalUrl || discoveredUrl}`;
      if ((canonicalUrl || discoveredUrl) && !seenAliases.has(aliasKey)) {
        seenAliases.add(aliasKey);
        operations.crawler_notice_url_aliases.push(
          makeOperation("would_upsert", "crawler_notice_url_aliases", { notice_ref: noticeRef, source_ref: sourceRef }, {
            url: canonicalUrl || discoveredUrl,
          }),
        );
      }

      if (discoveredUrl && discoveredUrl !== canonicalUrl) {
        const discoveredAliasKey = `${noticeRef}\u0000${discoveredUrl}`;
        if (!seenAliases.has(discoveredAliasKey)) {
          seenAliases.add(discoveredAliasKey);
          operations.crawler_notice_url_aliases.push(
            makeOperation("would_upsert", "crawler_notice_url_aliases", { notice_ref: noticeRef, source_ref: sourceRef }, {
              url: discoveredUrl,
            }),
          );
        }
      }

      operations.crawler_notice_occurrences.push(
        makeOperation("would_upsert", "crawler_notice_occurrences", {
          notice_ref: noticeRef,
          source_ref: sourceRef,
          run_ref: runRef,
          occurrence_ref: occurrenceRef,
        }, {
          discovered_url: discoveredUrl,
          final_url: normalizeUrl(item.final_url || item.canonical_url) || null,
          native_post_id: cleanText(item.native_post_id) || null,
          list_title: title,
          raw_list_text: cleanText(item.raw_list_text) || null,
          list_posted_at: postedAt,
          detail_fetched_at: toTimestampOrNull(item.detail_fetched_at),
          content_hash: contentHash,
          metadata: {
            dry_run: true,
            body_quality: cleanText(item.body_quality) || null,
            warnings: Array.isArray(item.warnings) ? item.warnings : [],
          },
        }),
      );

      for (const orgUnitId of orgUnitIds) {
        const targetKey = `${noticeRef}\u0000${orgUnitId}`;
        if (seenTargets.has(targetKey)) continue;
        seenTargets.add(targetKey);
        operations.crawler_notice_targets.push(
          makeOperation("would_upsert", "crawler_notice_targets", { notice_ref: noticeRef, source_ref: sourceRef }, {
            org_unit_id: orgUnitId,
            confidence: 1,
            evidence: {
              dry_run: true,
              source_key: sourceKey,
              mapping: "data/notice-sources.csv org_unit_id",
            },
          }),
        );
      }

      for (const [assetIndex, asset] of (Array.isArray(item.assets) ? item.assets : []).entries()) {
        const sourceUrl = normalizeUrl(asset.source_url || asset.url);
        if (!sourceUrl) continue;
        const assetKind = normalizeAssetKind(asset.asset_type || asset.asset_kind);
        const assetKey = `${noticeRef}\u0000${assetKind}\u0000${sourceUrl}`;
        if (seenAssets.has(assetKey)) continue;
        seenAssets.add(assetKey);
        operations.crawler_notice_assets.push(
          makeOperation("would_upsert", "crawler_notice_assets", {
            notice_ref: noticeRef,
            occurrence_ref: occurrenceRef,
            asset_ref: `asset:${noticeRef}:${assetIndex + 1}`,
          }, {
            asset_kind: assetKind,
            source_url: sourceUrl,
            storage_bucket: null,
            storage_key: null,
            filename: cleanText(asset.filename) || null,
            mime: cleanText(asset.content_type || asset.mime) || null,
            sha256: cleanText(asset.sha256) || null,
            width: Number.isInteger(asset.width) ? asset.width : null,
            height: Number.isInteger(asset.height) ? asset.height : null,
            position: assetIndex,
            alt: cleanText(asset.alt) || null,
            caption: cleanText(asset.caption) || null,
            extracted_text: cleanText(asset.extracted_text) || null,
            status: "referenced",
            metadata: { dry_run: true },
          }),
        );
      }

      const warnings = Array.isArray(item.warnings) ? item.warnings : [];
      const bodyQuality = cleanText(item.body_quality);
      const bodyText = cleanText(item.body_text ?? item.body);
      if (warnings.length > 0 || bodyQuality === "empty" || !bodyText) {
        sourceErrors.push("body_warning");
        operations.crawler_errors.push(
          makeOperation("would_error", "crawler_errors", {
            run_ref: runRef,
            source_ref: sourceRef,
            notice_ref: noticeRef,
            occurrence_ref: occurrenceRef,
          }, {
            stage: "ingest-dry-run-validate",
            error_class: bodyQuality === "empty" || !bodyText ? "BODY_QUALITY_WARNING" : "ITEM_WARNING",
            http_status: null,
            retry_count: 0,
            message: `Dry-run warning for ${sourceKey}: ${warnings.join(", ") || bodyQuality || "empty_body"}`,
            details: {
              dry_run: true,
              warnings,
              body_quality: bodyQuality || null,
            },
          }),
        );
      }
    }

    operations.crawler_source_results.push(
      makeOperation("would_upsert", "crawler_source_results", { run_ref: runRef, source_ref: sourceRef }, {
        decision: sourceErrors.length > 0 ? "partial" : "succeeded",
        counts: {
          input_items: source.items.length,
          planned_errors: sourceErrors.length,
        },
        strategy_code: "fixture-dry-run",
        adapter_code: cleanText(source.adapter_code) || null,
        elapsed_ms: null,
        error_count: sourceErrors.length,
        primary_failure_code: sourceErrors.length > 0 ? "BODY_QUALITY_WARNING" : null,
        metadata: {
          dry_run: true,
          source_key: sourceKey,
        },
      }),
    );
  }

  operations.crawler_runs[0].payload.totals = {
    sources: selectedSources.length,
    input_items: inputItems,
    planned_notices: operations.crawler_notices.length,
    planned_occurrences: operations.crawler_notice_occurrences.length,
    planned_targets: operations.crawler_notice_targets.length,
    planned_assets: operations.crawler_notice_assets.length,
    planned_errors: operations.crawler_errors.length,
    skipped: skipped.length,
  };

  const summary = {
    sources: selectedSources.length,
    input_items: inputItems,
    planned_runs: operations.crawler_runs.length,
    planned_source_results: operations.crawler_source_results.length,
    planned_notices: operations.crawler_notices.length,
    planned_url_aliases: operations.crawler_notice_url_aliases.length,
    planned_occurrences: operations.crawler_notice_occurrences.length,
    planned_targets: operations.crawler_notice_targets.length,
    planned_assets: operations.crawler_notice_assets.length,
    planned_keyword_matches: operations.crawler_keyword_matches.length,
    planned_errors: operations.crawler_errors.length,
    skipped: skipped.length,
    schema_blockers: schemaBlockers.length,
  };

  return {
    ok: schemaBlockers.length === 0 && skipped.length === 0,
    mode: options.checkDb ? "check-db" : "dry-run",
    fixture_path: path.normalize(options.fixturePath),
    db_write_executed: false,
    supabase_sql_executed: false,
    crawler_executed: false,
    summary,
    schema_blockers: schemaBlockers,
    skipped,
    planned_operations: operations,
    db_check: {
      executed: false,
      missing_sources: null,
      missing_source_targets: null,
      missing_org_units: null,
      db_write_executed: false,
    },
  };
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

function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ""))];
}

async function loadRowsByIn(supabase, table, columns, columnName, values) {
  const uniqueValues = unique(values);
  const rows = [];
  const pageSize = 100;
  for (let index = 0; index < uniqueValues.length; index += pageSize) {
    const chunk = uniqueValues.slice(index, index + pageSize);
    const { data, error } = await supabase.from(table).select(columns).in(columnName, chunk);
    if (error) throw new Error(`DB read failed for ${table}: ${error.message}`);
    rows.push(...(data ?? []));
  }
  return rows;
}

async function addDbCheck(report, options) {
  validateDbCheckOptions(options);
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const sourceKeys = unique(
    Object.values(report.planned_operations)
      .flat()
      .map((operation) => operation.refs?.source_ref?.replace(/^source:/, ""))
      .filter(Boolean),
  );
  const sourceRows = await loadRowsByIn(
    supabase,
    "crawler_notice_sources",
    "source_key,id",
    "source_key",
    sourceKeys,
  );
  const sourceIdByKey = new Map(sourceRows.map((row) => [row.source_key, row.id]));
  const sourceIds = unique([...sourceIdByKey.values()]);
  const targetRows =
    sourceIds.length > 0
      ? await loadRowsByIn(
          supabase,
          "crawler_source_targets",
          "source_id,org_unit_id",
          "source_id",
          sourceIds,
        )
      : [];
  const orgUnitRows =
    targetRows.length > 0
      ? await loadRowsByIn(supabase, "org_units", "id", "id", targetRows.map((row) => row.org_unit_id))
      : [];
  const orgUnitSet = new Set(orgUnitRows.map((row) => row.id));
  const targetSourceIdSet = new Set(targetRows.map((row) => row.source_id));

  const missingSources = sourceKeys.filter((sourceKey) => !sourceIdByKey.has(sourceKey));
  const missingSourceTargets = sourceKeys.filter((sourceKey) => {
    const sourceId = sourceIdByKey.get(sourceKey);
    return sourceId && !targetSourceIdSet.has(sourceId);
  });
  const missingOrgUnits = unique(
    targetRows.filter((row) => !orgUnitSet.has(row.org_unit_id)).map((row) => row.org_unit_id),
  );

  report.db_check = {
    executed: true,
    sources_checked: sourceKeys.length,
    source_targets_checked: targetRows.length,
    org_units_checked: orgUnitRows.length,
    missing_sources: missingSources.length,
    missing_source_targets: missingSourceTargets.length,
    missing_org_units: missingOrgUnits.length,
    db_write_executed: false,
  };
}

function printTextReport(report) {
  console.log("ingest_dry_run=ok");
  console.log(`mode=${report.mode}`);
  console.log(`db_write_executed=${report.db_write_executed}`);
  console.log(`sources=${report.summary.sources}`);
  console.log(`input_items=${report.summary.input_items}`);
  console.log(`planned_runs=${report.summary.planned_runs}`);
  console.log(`planned_source_results=${report.summary.planned_source_results}`);
  console.log(`planned_notices=${report.summary.planned_notices}`);
  console.log(`planned_url_aliases=${report.summary.planned_url_aliases}`);
  console.log(`planned_occurrences=${report.summary.planned_occurrences}`);
  console.log(`planned_targets=${report.summary.planned_targets}`);
  console.log(`planned_assets=${report.summary.planned_assets}`);
  console.log(`planned_keyword_matches=${report.summary.planned_keyword_matches}`);
  console.log(`planned_errors=${report.summary.planned_errors}`);
  console.log(`skipped=${report.summary.skipped}`);
  console.log(`schema_blockers=${report.summary.schema_blockers}`);
  if (report.db_check.executed) {
    console.log(`sources_checked=${report.db_check.sources_checked}`);
    console.log(`missing_sources=${report.db_check.missing_sources}`);
    console.log(`missing_source_targets=${report.db_check.missing_source_targets}`);
    console.log(`missing_org_units=${report.db_check.missing_org_units}`);
  }

  const preview = report.planned_operations.crawler_notices.slice(0, 3).map((operation) => ({
    operation: operation.operation,
    notice_ref: operation.refs.notice_ref,
    canonical_key: operation.payload.canonical_key,
    title: operation.payload.title,
  }));
  console.log("redacted_notice_preview=");
  console.log(JSON.stringify(preview, null, 2));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  validateDbCheckOptions(options);
  const fixture = readFixture(options.fixturePath);
  const report = buildDryRunReport(fixture, options);
  if (options.checkDb) {
    await addDbCheck(report, options);
  }

  if (options.outPath) {
    const outPath = path.resolve(options.outPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printTextReport(report);
  }

  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
