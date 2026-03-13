export function normalizeJoinKey(value) {
  if (value === null || value === undefined) return "";

  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/['\u2018\u2019]/g, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
