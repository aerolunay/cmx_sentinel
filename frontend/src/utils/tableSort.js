// Generic comparator for table sorting - shared so Agents/Users (and
// any future sortable table) all sort consistently instead of each
// page hand-rolling its own comparison logic.
//
// Numeric-aware: a value that's a plain integer STRING (like Agent ID
// - "9", "10", "241") sorts as a number, not lexicographically -
// otherwise "10" would sort before "9", which is correct for text but
// wrong for an ID. Booleans (e.g. is_active) sort false-before-true.
// Everything else falls back to a locale-aware, case-insensitive
// string compare, which also correctly handles null/undefined (as "").
export function compareValues(a, b) {
  if (typeof a === "boolean" || typeof b === "boolean") {
    return (a ? 1 : 0) - (b ? 1 : 0);
  }

  const aStr = String(a ?? "").trim();
  const bStr = String(b ?? "").trim();
  const aIsInt = /^\d+$/.test(aStr);
  const bIsInt = /^\d+$/.test(bStr);
  if (aIsInt && bIsInt) {
    return Number(aStr) - Number(bStr);
  }

  return aStr.localeCompare(bStr, undefined, { sensitivity: "base" });
}

/**
 * Sorts `rows` by `getValue(row)` according to `sort` ({ key, dir }).
 * Returns `rows` unchanged (same reference) if `sort.key` is null, so
 * callers can freely pass this through a useMemo without worrying
 * about the "no sort applied yet" case.
 */
export function sortRows(rows, sort, getValue) {
  if (!sort.key) return rows;
  const factor = sort.dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => factor * compareValues(getValue(a), getValue(b)));
}

/**
 * Case-insensitive substring match against ANY of `fields` (already-
 * extracted string values, not accessor functions) - used for the
 * Name/ID/Group search boxes. An empty query matches everything.
 */
export function matchesSearch(query, fields) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => String(f ?? "").toLowerCase().includes(q));
}
