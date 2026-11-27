import { test } from "node:test";
import assert from "node:assert/strict";
import { camProblem, isBookingCode, outcome } from "../src/scan.ts";

test("gate outcome follows the server's verdict; cancellation is shown as its own warning", () => {
  assert.equal(outcome({ kind: "valid", reason: "Entry approved" }), "valid");
  assert.equal(outcome({ kind: "duplicate", reason: "Already used" }), "duplicate");
  assert.equal(outcome({ kind: "invalid", reason: "Ticket cancelled" }), "cancelled");
  assert.equal(outcome({ kind: "invalid", reason: "Invalid QR code – ticket not found" }), "invalid");
  assert.equal(outcome({ kind: "invalid", reason: "Payment not completed" }), "invalid");
});

test("camera failures map to the message staff see", () => {
  assert.equal(camProblem({ name: "NotAllowedError" }), "denied");
  assert.equal(camProblem({ name: "NotFoundError" }), "nocamera");
  assert.equal(camProblem({ name: "NotReadableError" }), "busy");
  assert.equal(camProblem(new Error("unsupported")), "unsupported");
});

test("the server status decides cancellation when present", () => {
  assert.equal(outcome({ kind: "invalid", reason: "Ticket cancelled", status: "CANCELLED" }), "cancelled");
  assert.equal(outcome({ kind: "invalid", reason: "Ticket cancelled", status: "INVALID" }), "invalid");
});

test("booking QRs and typed booking refs open group admission; ticket QRs do not", () => {
  assert.ok(isBookingCode("MGMBK1|MGM-PJDH2Q|2026-11-26|ABCDEFGHJKLM"));
  assert.ok(isBookingCode(" mgm-pjdh2q "));
  assert.ok(!isBookingCode("MGMDW2|TKT-DV58B9M3|MGM-PJDH2Q|2026-11-26|ABCDEFGHJKLM"));
  assert.ok(!isBookingCode("TKT-DV58B9M3"));
});
