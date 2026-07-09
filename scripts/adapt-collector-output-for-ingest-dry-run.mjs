import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const VALID_FORMATS = new Set([
  "auto",
  "collector-output",
  "collector-report",
  "candidate-list",
  "synthetic-compatible",
]);
const DEFAULT_FORMAT = "auto";
const SAFE_ITEM_WARNING_THRESHOLD = 1000;
const MAX_METADATA_STRING_LENGTH = 500;
const MAX_METADATA_ARRAY_LENGTH = 5;

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parseArgs(argv) {
  const options = {
    inputPath: "",
    outPath: "",
    sourceKey: "",
    limit: 0,
    json: false,
    format: DEFAULT_FORMAT,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--input") {
      if (!next) throw new Error("--input requires a path.");
      options.inputPath = next;
      index += 1;
    } else if (arg === "--out") {
      if (!next) throw new Error("--out requires a path.");
      options.outPath = next;
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
    } else if (arg === "--format") {
      if (!next) throw new Error("--format requires a value.");
      options.format = cleanText(next).toLowerCase();
      if (!VALID_FORMATS.has(options.format)) {
        throw new Error(`--format must be one of: ${[...VALID_FORMATS].join(", ")}`);
      }
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (["--apply", "--write", "--commit"].includes(arg)) {
      throw new Error(`${arg} is not supported. This adapter never writes to DB.`);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/adapt-collector-output-for-ingest-dry-run.mjs --input <path> --out fixtures/crawler-ingest-dry-run/adapted-sample.json [--source-key cau_002] [--limit N] [--json] [--format auto|collector-output|collector-report|candidate-list|synthetic-compatible]

Options:
  --input PATH            Collector/report/fixture JSON path.
  --out PATH              Save adapted ingest dry-run fixture JSON.
  --source-key KEY        Filter matching source keys, or use as fallback when input has none.
  --limit N               Limit adapted input items. 0 or omitted means no limit.
  --json                  Print the adapted fixture JSON.
  --format FORMAT         Defaults to auto.

Safety:
  No DB connection, no DB writes, no .env loading, no SQL execution, no crawler
  execution, and no apply/write/commit mode.
`);
}

function requireInput(options) {
  if (!options.inputPath) throw new Error("--input is required.");
}

function readJsonLike(inputPath) {
  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved)) throw new Error(`Input not found: ${inputPath}`);
  const raw = fs.readFileSync(resolved, "utf8").replace(/^\uFEFF/, "");
  if (resolved.toLowerCase().endsWith(".jsonl")) {
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  return JSON.parse(raw);
}

function hashText(value, length = 12) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, length);
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

function toDateOrEmpty(value) {
  const text = cleanText(value);
  if (!text) return "";
  const head = text.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(head)) return head;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}

function toTimestampOrNow(value) {
  const text = cleanText(value);
  if (text) {
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

function firstString(object, names) {
  if (!object || typeof object !== "object") return "";
  for (const name of names) {
    const value = object[name];
    if (typeof value === "string" || typeof value === "number") {
      const text = cleanText(value);
      if (text) return text;
    }
  }
  return "";
}

function firstArray(object, names) {
  if (!object || typeof object !== "object") return [];
  for (const name of names) {
    if (Array.isArray(object[name])) return object[name];
  }
  return [];
}

function truncateMetadata(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > MAX_METADATA_STRING_LENGTH
      ? `${value.slice(0, MAX_METADATA_STRING_LENGTH)}...`
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 2) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, MAX_METADATA_ARRAY_LENGTH).map((item) => truncateMetadata(item, depth + 1));
  }
  if (typeof value === "object") {
    const result = {};
    for (const [key, child] of Object.entries(value).slice(0, 20)) {
      if (/(secret|token|key|password|authorization|cookie|env)/i.test(key)) continue;
      if (/(html|body_html|content)$/i.test(key) && cleanText(child).length > MAX_METADATA_STRING_LENGTH) {
        result[key] = "[truncated]";
      } else {
        result[key] = truncateMetadata(child, depth + 1);
      }
    }
    return result;
  }
  return String(value);
}

function normalizeAssets(item) {
  const assets = [];
  const candidates = [
    ...firstArray(item, ["assets", "attachments", "files", "images"]),
    ...(item.attachment ? [item.attachment] : []),
  ];

  for (const asset of candidates) {
    if (!asset || typeof asset !== "object") continue;
    const sourceUrl = normalizeUrl(firstString(asset, ["source_url", "url", "href", "download_url", "file_url"]));
    if (!sourceUrl) continue;
    assets.push({
      asset_type: cleanText(firstString(asset, ["asset_type", "asset_kind", "type", "kind"])) || "attachment",
      filename: cleanText(firstString(asset, ["filename", "name", "file_name", "title"])) || null,
      source_url: sourceUrl,
      content_type: cleanText(firstString(asset, ["content_type", "mime", "mime_type"])) || null,
      alt: cleanText(firstString(asset, ["alt", "alt_text"])) || null,
      caption: cleanText(firstString(asset, ["caption", "description"])) || null,
    });
  }

  return assets;
}

function sourceKeyFor(recordSourceKey, fallbackSourceKey, hasNativeSourceKey) {
  const sourceKey = cleanText(recordSourceKey).toLowerCase();
  if (sourceKey) return sourceKey;
  if (fallbackSourceKey) return fallbackSourceKey;
  if (!hasNativeSourceKey) return "";
  return sourceKey;
}

function normalizeItem(record, context, options, state) {
  const sourceKey = sourceKeyFor(record.sourceKey, options.sourceKey, context.hasNativeSourceKey);
  if (!sourceKey) {
    state.adapterErrors.push({
      item_index: context.itemIndex,
      reason: "missing_source_key",
    });
    return null;
  }

  const item = record.item ?? {};
  const title = firstString(item, ["title", "listTitle", "list_title", "name", "subject"]);
  if (!title) {
    state.skipped.push({
      source_key: sourceKey,
      item_index: context.itemIndex,
      reason: "missing_title",
    });
    return null;
  }

  const discoveredUrl = normalizeUrl(
    firstString(item, ["discovered_url", "noticeUrl", "notice_url", "url", "href", "link", "detail_url"]),
  );
  const canonicalUrl = normalizeUrl(
    firstString(item, ["canonical_url", "final_url", "finalUrl", "resolved_url"]) || discoveredUrl,
  );
  const bodyText = cleanText(firstString(item, ["body_text", "bodyText", "content", "body", "text", "detailText"]));
  const bodyHtml = cleanText(firstString(item, ["body_html", "bodyHtml", "html"]));
  const publishedAt = toDateOrEmpty(
    firstString(item, ["published_at", "posted_at", "parsedDate", "parsed_date", "detailDate", "dateText", "date"]),
  );

  const warnings = [];
  if (!discoveredUrl) warnings.push("missing_discovered_url");
  if (!bodyText) warnings.push("missing_body_text");
  if (context.warning) warnings.push(context.warning);

  const output = {
    title,
    discovered_url: discoveredUrl,
    canonical_url: canonicalUrl,
    published_at: publishedAt,
    body_text: bodyText,
    body_html: bodyHtml,
    body_quality: cleanText(firstString(item, ["body_quality", "bodyQuality"])) || (bodyText ? "adapted" : "empty"),
    raw_list_text: cleanText(firstString(item, ["rawListText", "raw_list_text", "listText"])) || null,
    assets: normalizeAssets(item),
    warnings: [...new Set([...(Array.isArray(item.warnings) ? item.warnings.map(cleanText) : []), ...warnings])].filter(
      Boolean,
    ),
    metadata: {
      adapter_format: context.format,
      source_name: cleanText(context.sourceName) || null,
      raw: truncateMetadata(item),
    },
  };

  return { sourceKey, item: output };
}

function collectSyntheticRecords(data) {
  const records = [];
  for (const source of data.sources ?? []) {
    const sourceKey = cleanText(source.source_key ?? source.sourceId ?? source.source_id).toLowerCase();
    const items = Array.isArray(source.items) ? source.items : [];
    for (const [itemIndex, item] of items.entries()) {
      records.push({
        sourceKey,
        item,
        context: {
          format: "synthetic-compatible",
          hasNativeSourceKey: Boolean(sourceKey),
          itemIndex,
          sourceName: source.source_name ?? source.sourceName,
        },
      });
    }
  }
  return records;
}

function collectCollectorOutputRecords(data) {
  const records = [];
  for (const source of data.sources ?? []) {
    const sourceKey = cleanText(source.source_key ?? source.sourceId ?? source.source_id).toLowerCase();
    const sourceWarnings = Array.isArray(source.warnings) ? source.warnings.map(cleanText).filter(Boolean) : [];
    const sourceErrors = Array.isArray(source.errors) ? source.errors.map(cleanText).filter(Boolean) : [];
    const items = Array.isArray(source.items) ? source.items : [];
    for (const [itemIndex, item] of items.entries()) {
      const itemWarnings = Array.isArray(item.warnings) ? item.warnings.map(cleanText).filter(Boolean) : [];
      records.push({
        sourceKey,
        item: {
          ...item,
          warnings: [...new Set([...itemWarnings, ...sourceWarnings, ...sourceErrors])].filter(Boolean),
        },
        context: {
          format: "collector-output:sources.items",
          hasNativeSourceKey: Boolean(sourceKey),
          itemIndex,
          sourceName: source.source_name ?? source.sourceName,
        },
      });
    }
  }
  return records;
}

function collectCollectorRecords(data) {
  const records = [];

  if (Array.isArray(data.newNotices)) {
    for (const [itemIndex, item] of data.newNotices.entries()) {
      records.push({
        sourceKey: cleanText(item.sourceId ?? item.source_key ?? item.source_id).toLowerCase(),
        item,
        context: {
          format: "collector-report:newNotices",
          hasNativeSourceKey: Boolean(item.sourceId ?? item.source_key ?? item.source_id),
          itemIndex,
          sourceName: item.sourceName,
        },
      });
    }
  }

  if (Array.isArray(data.perSource)) {
    for (const source of data.perSource) {
      const sourceKey = cleanText(source.sourceId ?? source.source_key ?? source.source_id).toLowerCase();
      const notices = firstArray(source.samples, ["notices", "items", "candidates"]);
      for (const [itemIndex, item] of notices.entries()) {
        records.push({
          sourceKey,
          item,
          context: {
            format: "collector-report:perSource.samples.notices",
            hasNativeSourceKey: Boolean(sourceKey),
            itemIndex,
            sourceName: source.sourceName,
            warning: "audit_sample_notice",
          },
        });
      }
    }
  }

  return records;
}

function findCandidateArray(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  for (const key of ["items", "notices", "candidates", "results", "records", "rows", "data"]) {
    if (Array.isArray(data[key])) return data[key];
  }
  return [];
}

function collectCandidateRecords(data) {
  const items = findCandidateArray(data);
  return items.map((item, itemIndex) => ({
    sourceKey: cleanText(item.source_key ?? item.sourceId ?? item.source_id).toLowerCase(),
    item,
    context: {
      format: "candidate-list",
      hasNativeSourceKey: Boolean(item.source_key ?? item.sourceId ?? item.source_id),
      itemIndex,
      sourceName: item.source_name ?? item.sourceName,
    },
  }));
}

function detectFormat(data, requestedFormat) {
  if (requestedFormat !== "auto") return requestedFormat;
  if (data && typeof data === "object" && Array.isArray(data.sources) && data.collector_output_version) {
    return "collector-output";
  }
  if (data && typeof data === "object" && Array.isArray(data.sources)) return "synthetic-compatible";
  if (data && typeof data === "object" && (Array.isArray(data.newNotices) || Array.isArray(data.perSource))) {
    return "collector-report";
  }
  return "candidate-list";
}

function collectRecords(data, format) {
  if (format === "collector-output") return collectCollectorOutputRecords(data);
  if (format === "synthetic-compatible") return collectSyntheticRecords(data);
  if (format === "collector-report") return collectCollectorRecords(data);
  if (format === "candidate-list") return collectCandidateRecords(data);
  throw new Error(`Unsupported format: ${format}`);
}

function groupBySource(normalizedItems) {
  const groups = new Map();
  for (const normalized of normalizedItems) {
    if (!groups.has(normalized.sourceKey)) {
      groups.set(normalized.sourceKey, { source_key: normalized.sourceKey, items: [] });
    }
    groups.get(normalized.sourceKey).items.push(normalized.item);
  }
  return [...groups.values()];
}

function collectorOutputSourceShells(data, options) {
  if (!data || typeof data !== "object" || !Array.isArray(data.sources)) return [];
  return data.sources
    .map((source) => ({
      source_key: cleanText(source.source_key ?? source.sourceId ?? source.source_id).toLowerCase(),
      items: [],
      adapter_code: cleanText(source.adapter_code ?? source.adapterCode) || null,
    }))
    .filter((source) => source.source_key && (!options.sourceKey || source.source_key === options.sourceKey));
}

function mergeSourceShells(sources, shells) {
  const byKey = new Map(sources.map((source) => [source.source_key, source]));
  for (const shell of shells) {
    if (!byKey.has(shell.source_key)) byKey.set(shell.source_key, shell);
  }
  return [...byKey.values()];
}

function collectSourceDiagnostics(data, options) {
  if (!data || typeof data !== "object" || !Array.isArray(data.sources)) return [];
  return data.sources
    .map((source) => ({
      source_key: cleanText(source.source_key ?? source.sourceId ?? source.source_id).toLowerCase(),
      source_name: cleanText(source.source_name ?? source.sourceName) || null,
      crawled_count: Number.isFinite(source.crawled_count) ? source.crawled_count : null,
      matched_count: Number.isFinite(source.matched_count) ? source.matched_count : null,
      output_items: Array.isArray(source.items) ? source.items.length : 0,
      body_quality: cleanText(source.body_quality) || null,
      asset_quality: cleanText(source.asset_quality) || null,
      warnings: Array.isArray(source.warnings) ? source.warnings.map(cleanText).filter(Boolean) : [],
      errors: Array.isArray(source.errors) ? source.errors.map(cleanText).filter(Boolean) : [],
    }))
    .filter((source) => source.source_key && (!options.sourceKey || source.source_key === options.sourceKey));
}

function adaptFixture(data, options) {
  const detectedFormat = detectFormat(data, options.format);
  const records = collectRecords(data, detectedFormat);
  const matchingRecords = options.sourceKey
    ? records.filter((record) => !record.sourceKey || cleanText(record.sourceKey).toLowerCase() === options.sourceKey)
    : records;
  const limitApplied = options.limit > 0 ? Math.min(options.limit, matchingRecords.length) : matchingRecords.length;
  const selectedRecords = options.limit > 0 ? matchingRecords.slice(0, options.limit) : matchingRecords;
  const state = {
    skipped: [],
    warnings: [],
    adapterErrors: [],
  };

  if (options.limit === 0 && records.length > SAFE_ITEM_WARNING_THRESHOLD) {
    state.warnings.push(
      `Large input contains ${records.length} candidate items. Use --limit N for smaller review fixtures.`,
    );
  }

  const normalizedItems = [];
  for (const [selectedIndex, record] of selectedRecords.entries()) {
    const normalized = normalizeItem(
      record,
      { ...record.context, itemIndex: record.context.itemIndex ?? selectedIndex },
      options,
      state,
    );
    if (normalized) normalizedItems.push(normalized);
  }

  const generatedAt = new Date().toISOString();
  const inputIdentity = JSON.stringify({
    input: path.normalize(options.inputPath),
    format: detectedFormat,
    sourceKey: options.sourceKey || null,
    limit: options.limit || null,
    count: normalizedItems.length,
  });

  const sources =
    detectedFormat === "collector-output"
      ? mergeSourceShells(groupBySource(normalizedItems), collectorOutputSourceShells(data, options))
      : groupBySource(normalizedItems);

  return {
    adapter_note: "Adapted local collector/report output for crawler ingest dry-run only. No DB write, SQL, or crawler execution occurred.",
    adapter: {
      input_path: path.normalize(options.inputPath),
      requested_format: options.format,
      detected_format: detectedFormat,
      generated_at: generatedAt,
      source_key_filter_or_fallback: options.sourceKey || null,
      input_items_seen: records.length,
      matching_items_seen: matchingRecords.length,
      limit_applied: limitApplied,
      output_items: normalizedItems.length,
      skipped: state.skipped,
      warnings: state.warnings,
      adapter_errors: state.adapterErrors,
      source_diagnostics: detectedFormat === "collector-output" ? collectSourceDiagnostics(data, options) : [],
      db_write_executed: false,
      supabase_sql_executed: false,
      crawler_executed: false,
    },
    run: {
      run_key: `adapted-collector-output-${hashText(inputIdentity)}`,
      started_at: generatedAt,
      mode: "manual",
      parser_version: "ingest-dry-run-v1",
    },
    sources,
  };
}

function printTextReport(fixture) {
  console.log("collector_output_adapter=ok");
  console.log(`detected_format=${fixture.adapter.detected_format}`);
  console.log(`db_write_executed=${fixture.adapter.db_write_executed}`);
  console.log(`supabase_sql_executed=${fixture.adapter.supabase_sql_executed}`);
  console.log(`crawler_executed=${fixture.adapter.crawler_executed}`);
  console.log(`input_items_seen=${fixture.adapter.input_items_seen}`);
  console.log(`matching_items_seen=${fixture.adapter.matching_items_seen}`);
  console.log(`output_items=${fixture.adapter.output_items}`);
  console.log(`sources=${fixture.sources.length}`);
  console.log(`skipped=${fixture.adapter.skipped.length}`);
  console.log(`adapter_errors=${fixture.adapter.adapter_errors.length}`);
  if (fixture.adapter.warnings.length > 0) {
    console.log(`warnings=${fixture.adapter.warnings.length}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  requireInput(options);
  const data = readJsonLike(options.inputPath);
  const fixture = adaptFixture(data, options);

  if (options.outPath) {
    const outPath = path.resolve(options.outPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  }

  if (options.json) {
    console.log(JSON.stringify(fixture, null, 2));
  } else {
    printTextReport(fixture);
  }

  if (fixture.adapter.adapter_errors.length > 0 || fixture.sources.length === 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
