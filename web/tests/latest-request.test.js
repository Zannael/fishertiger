import test from "node:test";
import assert from "node:assert/strict";
import { createRequestGate } from "../src/latest-request.js";

test("only the newest claim is current", () => {
  const gate = createRequestGate();
  const first = gate.claim();
  assert.equal(gate.isCurrent(first), true);
  const second = gate.claim();
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
});

test("a request never becomes current again once superseded", () => {
  const gate = createRequestGate();
  const stale = gate.claim();
  gate.claim();
  gate.claim();
  assert.equal(gate.isCurrent(stale), false);
});

test("a reply that lands after a switch is rejected, the newer one is kept", () => {
  const gate = createRequestGate();
  const generateA = gate.claim();
  const selectB = gate.claim();
  assert.equal(gate.isCurrent(generateA), false, "A's dataset must be dropped");
  assert.equal(gate.isCurrent(selectB), true, "B stays the active profile");
});

test("gates are independent", () => {
  const one = createRequestGate();
  const two = createRequestGate();
  const request = one.claim();
  two.claim();
  two.claim();
  assert.equal(one.isCurrent(request), true);
});

test("nothing is current before the first claim", () => {
  assert.equal(createRequestGate().isCurrent(1), false);
});
