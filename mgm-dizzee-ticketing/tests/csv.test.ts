import { test } from "node:test";
import assert from "node:assert/strict";
import { csvName, money2, toCsv } from "../src/csv.ts";

test("CSV is Excel-friendly: BOM, CRLF, quoting, plain numbers", () => {
  const out = toCsv(["State", "Revenue (INR)", "Note"], [["Tamil Nadu", 1661, 'says "hi", ok'], ["Unknown", 0, null]]);
  assert.ok(out.startsWith("﻿"));
  assert.equal(out, '﻿State,Revenue (INR),Note\r\nTamil Nadu,1661,"says ""hi"", ok"\r\nUnknown,0,\r\n');
});

test("empty datasets still produce a valid header-only file", () => {
  assert.equal(toCsv(["A", "B"], []), "﻿A,B\r\n");
});

test("formula-looking text is neutralised but numbers are not", () => {
  const out = toCsv(["x", "n"], [["=HYPERLINK(\"http://x\")", -5], ["@cmd", 2.5], ["+91 98400", 0]]);
  assert.match(out, /\r\n"'=HYPERLINK\(""http:\/\/x""\)",-5\r\n'@cmd,2.5\r\n'\+91 98400,0\r\n$/);
});

test("money and filenames", () => {
  assert.equal(money2(175.8400001), 175.84);
  assert.equal(csvName("regional-sales", "2026-11-01", "", "2026-11-26"), "mgm-regional-sales_2026-11-01_to_today_exported-2026-11-26.csv");
});
