export function normalizeTerm(input) {
  return String(input ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll("$", "")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function sameNameOrTicker(term, name, symbol) {
  const normalized = normalizeTerm(term);
  if (!normalized) return false;
  return normalizeTerm(name) === normalized || normalizeTerm(symbol) === normalized;
}

export function parseTerms(text) {
  const seen = new Set();
  const terms = [];
  for (const part of String(text ?? "").split(",")) {
    const raw = part.trim();
    const normalized = normalizeTerm(raw);
    if (!raw || !normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    terms.push({ raw, normalized });
    if (terms.length >= 8) break;
  }
  return terms;
}

export function repeatedGroups(launches) {
  const groups = new Map();
  for (const launch of launches) {
    for (const term of [launch.symbol, launch.name]) {
      const normalized = normalizeTerm(term);
      if (!normalized) continue;
      if (!groups.has(normalized)) groups.set(normalized, new Map());
      groups.get(normalized).set(launch.mint, launch);
    }
  }
  return [...groups.entries()]
    .map(([term, mints]) => ({ term, launches: [...mints.values()] }))
    .filter((group) => group.launches.length >= 2)
    .sort((a, b) => b.launches.length - a.launches.length || b.launches[0].at - a.launches[0].at);
}

export function busiestCreators(launches) {
  const counts = new Map();
  for (const launch of launches) {
    if (!launch.creator) continue;
    counts.set(launch.creator, (counts.get(launch.creator) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([creator, count]) => ({ creator, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
}

function higherCap(left, right) {
  const a = Number(left);
  const b = Number(right);
  const aOk = Number.isFinite(a);
  const bOk = Number.isFinite(b);
  if (!aOk) return bOk ? b : null;
  if (!bOk) return a;
  return Math.max(a, b);
}

function createdAtMs(value) {
  const at = Number(value);
  if (!Number.isFinite(at) || at <= 0) return null;
  return at < 1e12 ? Math.round(at * 1000) : Math.round(at);
}

function earlierAt(left, right) {
  const a = createdAtMs(left);
  const b = createdAtMs(right);
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

export function mergeCopies(items, officialMints) {
  const skip = new Set(officialMints || []);
  const merged = new Map();
  for (const item of items) {
    if (!item?.mint || skip.has(item.mint)) continue;
    const existing = merged.get(item.mint);
    if (!existing) {
      merged.set(item.mint, { ...item, sources: [...item.sources], createdAt: createdAtMs(item.createdAt) });
      continue;
    }
    existing.sources = [...new Set([...existing.sources, ...item.sources])];
    existing.name = existing.name || item.name;
    existing.symbol = existing.symbol || item.symbol;
    existing.creator = existing.creator || item.creator;
    existing.dexId = existing.dexId || item.dexId;
    existing.url = existing.url || item.url;
    existing.marketCapUsd = higherCap(existing.marketCapUsd, item.marketCapUsd);
    existing.createdAt = earlierAt(existing.createdAt, item.createdAt);
  }
  return [...merged.values()];
}
