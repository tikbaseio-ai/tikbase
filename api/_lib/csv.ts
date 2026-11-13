// CSV for the Pro export. Pure.
//
// Two rules beyond RFC 4180 quoting:
//   - an absent value is an EMPTY cell. Not 0: a spreadsheet would sum it and
//     present "we have no figure" as "it sold nothing" (the em-dash rule from
//     the UI, carried to the file);
//   - text that starts with = + - @ tab or CR is prefixed with a single quote.
//     Product titles and shop names are scraped, third-party strings; opened in
//     Excel, "=HYPERLINK(...)" in a title would execute. Numbers are exempt so
//     a legitimately negative growth figure stays numeric.

const FORMULA_LEAD = /^[=+\-@\t\r]/;

export type CsvCell = string | number | boolean | null | undefined;

export function csvCell(v: CsvCell): string {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  let s = String(v);
  if (FORMULA_LEAD.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCsv<T>(
  columns: { header: string; value: (row: T, index: number) => CsvCell }[],
  rows: T[],
): string {
  const head = columns.map((c) => csvCell(c.header)).join(',');
  const body = rows.map((r, i) => columns.map((c) => csvCell(c.value(r, i))).join(','));
  // BOM so Excel reads UTF-8 (product names are multilingual).
  return '﻿' + [head, ...body].join('\r\n') + '\r\n';
}
