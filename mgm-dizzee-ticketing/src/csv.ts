// CSV export for analytics reports. Output opens cleanly in Excel: UTF-8 with BOM (so ₹ and Indian names
// survive), CRLF line endings, RFC 4180 quoting, plain numbers (no thousands separators) and ISO dates.
export type Cell = string | number | null | undefined;

/** Text that a spreadsheet would treat as a formula is prefixed with ' (CSV/formula injection guard). */
function cell(v: Cell): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: Cell[][]): string {
  return "﻿" + [headers, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

/** Money with exactly two decimals, as a number Excel can sum. */
export const money2 = (n: number) => Math.round(n * 100) / 100;

/** e.g. mgm-regional-sales_2026-11-01_to_2026-11-30_exported-2026-11-26.csv */
export function csvName(report: string, from: string, to: string, today: string) {
  return `mgm-${report}_${from || "all-time"}_to_${to || "today"}_exported-${today}.csv`;
}

export function downloadCsv(filename: string, headers: string[], rows: Cell[][]) {
  const url = URL.createObjectURL(new Blob([toCsv(headers, rows)], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
