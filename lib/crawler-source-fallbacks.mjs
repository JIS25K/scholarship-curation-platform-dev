const FALLBACK_REQUIRED_SOURCE_IDS = new Set([
  "cau_002",
  "cau_020",
  "cau_064",
  "cau_072",
  "cau_077",
  "ewha_028",
  "ewha_052",
  "hanyang_007",
  "hanyang_012",
  "hanyang_014",
  "hanyang_018",
  "hanyang_021",
  "hanyang_036",
  "khu_038",
  "korea_013",
  "korea_014",
  "korea_027",
  "korea_028",
  "korea_033",
  "korea_060",
  "korea_061",
  "korea_063",
  "korea_067",
  "skku_042",
  "skku_051",
  "skku_053",
  "skku_056",
  "skku_057",
  "skku_059",
  "skku_062",
  "skku_065",
  "uos_022",
  "uos_037",
  "uos_040",
  "yonsei_010",
  "yonsei_024",
  "yonsei_026",
  "yonsei_036",
  "yonsei_051",
  "yonsei_052",
  "yonsei_053",
  "yonsei_054",
  "yonsei_055",
]);

const UNIVERSITY_WIDE_FALLBACKS = new Map([
  ["cau", "cau_univ_001"],
  ["yonsei", "yonsei_069"],
]);

const ACCESS_FIELDS = [
  "listUrl",
  "baseUrl",
  "listItemSelector",
  "linkSelector",
  "titleSelector",
  "dateSelector",
  "detailContentSelector",
  "detailDateSelector",
  "noticeUrlPattern",
  "adapter",
  "detailAccessMode",
  "browserNetworkEvidence",
];

function pickFallbackSource(source, sources, byId) {
  const universityWideId = UNIVERSITY_WIDE_FALLBACKS.get(source.universitySlug);
  const universityWide = universityWideId ? byId.get(universityWideId) : null;
  if (universityWide && !FALLBACK_REQUIRED_SOURCE_IDS.has(universityWide.sourceId)) {
    return universityWide;
  }

  const sameCollege = sources.find(
    (candidate) =>
      candidate.sourceId !== source.sourceId &&
      !FALLBACK_REQUIRED_SOURCE_IDS.has(candidate.sourceId) &&
      candidate.universitySlug === source.universitySlug &&
      source.collegeId &&
      candidate.collegeId === source.collegeId,
  );
  if (sameCollege) return sameCollege;

  return sources.find(
    (candidate) =>
      candidate.sourceId !== source.sourceId &&
      !FALLBACK_REQUIRED_SOURCE_IDS.has(candidate.sourceId) &&
      candidate.universitySlug === source.universitySlug,
  );
}

export function applyOfficialSourceFallbacks(sources) {
  const byId = new Map(sources.map((source) => [source.sourceId, source]));
  return sources.map((source) => {
    if (!FALLBACK_REQUIRED_SOURCE_IDS.has(source.sourceId)) return source;
    const fallback = pickFallbackSource(source, sources, byId);
    if (!fallback) return source;
    const resolved = {
      ...source,
      configuredListUrl: source.listUrl,
      fallbackSourceId: fallback.sourceId,
      fallbackReason: "primary_source_unavailable_or_unparseable",
    };
    for (const field of ACCESS_FIELDS) resolved[field] = fallback[field];
    return resolved;
  });
}

export { FALLBACK_REQUIRED_SOURCE_IDS };
