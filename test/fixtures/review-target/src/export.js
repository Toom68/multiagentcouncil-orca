export function exportEntries(entries) {
  return entries.map((entry) => ({ ...entry }));
}

export function exportJson(entries) {
  return JSON.stringify(exportEntries(entries), null, 2);
}
