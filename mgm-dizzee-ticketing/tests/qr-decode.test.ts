// The gate scanner's fallback decoder (ZXing WebAssembly, used where the browser has no native BarcodeDetector,
// e.g. iOS Safari) must read the QR codes the ticket page draws with src/qr.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import { qrMatrix } from "../src/qr.ts";

function render(text: string, scale = 6, quiet = 4) {
  const m = qrMatrix(text); const n = (m.length + quiet * 2) * scale;
  const data = new Uint8ClampedArray(n * n * 4).fill(255);
  m.forEach((row, y) => row.forEach((dark, x) => {
    if (!dark) return;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const i = (((y + quiet) * scale + dy) * n + (x + quiet) * scale + dx) * 4;
      data[i] = data[i + 1] = data[i + 2] = 0;
    }
  }));
  return { data, width: n, height: n, colorSpace: "srgb" } as ImageData;
}

test("signed ticket QR drawn by the app is decoded by the scanner's WebAssembly reader", async () => {
  const wasm = await readFile(new URL("../node_modules/zxing-wasm/dist/reader/zxing_reader.wasm", import.meta.url));
  await prepareZXingModule({ overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer }, fireImmediately: true });
  const payload = "MGMDW2|TKT-DV58B9M3|MGM-PJDH2Q|2026-11-26|ABCDEFGHJKLM";
  const [hit] = await readBarcodes(render(payload), { formats: ["QRCode"] });
  assert.equal(hit?.text, payload);
});
