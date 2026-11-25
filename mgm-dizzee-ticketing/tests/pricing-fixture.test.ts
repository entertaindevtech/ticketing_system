// Fails when the TypeScript pricing engine changes without regenerating the parity fixture
// (node scripts/pricing-fixture.ts), which backend/tests/test_pricing_parity.py replays against the Python engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FIXTURE, buildFixture } from "../scripts/pricing-fixture.ts";

test("pricing parity fixture is up to date with src/store.ts", () => {
  assert.deepEqual(JSON.parse(readFileSync(FIXTURE, "utf8")), JSON.parse(JSON.stringify(buildFixture())));
});
