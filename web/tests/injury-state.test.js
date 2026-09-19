import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  effectiveAvailability,
  enrichPlayersWithAvailability,
  normalizeInjuryStatus,
  shouldRefreshInjuries,
  sharedCheck,
} from "../src/injury-state.js";
import { FORCE_AVAILABLE, FORCE_OUT } from "../src/player-injuries.js";

const automatic = { fantacalcio_id: 7, availability: "QUESTIONABLE", reason: "Knock" };

test("automatic state normalization keeps only valid resolved availability", () => {
  const status = normalizeInjuryStatus({
    state: "fresh",
    configured: true,
    cache_age_seconds: 10,
    snapshot: { players: [automatic, { fantacalcio_id: 8, availability: "SUSPENDED" }], unresolved: [{ provider_player_name: "Unknown" }] },
  });
  assert.equal(status.snapshot.players.length, 1);
  assert.equal(status.snapshot.unresolved.length, 1);
});

test("automatic state applies with no override", () => {
  assert.equal(effectiveAvailability(automatic, null).effective, "QUESTIONABLE");
});

test("manual overrides force unavailable or suppress automatic availability", () => {
  assert.equal(effectiveAvailability(automatic, FORCE_OUT).effective, "OUT");
  assert.equal(effectiveAvailability(automatic, FORCE_AVAILABLE).effective, null);
});

test("enrichment is immutable and never creates confirmed_inactive", () => {
  const original = { id: 7, nome: "Player" };
  const [enriched] = enrichPlayersWithAvailability(
    [original],
    { snapshot: { players: [automatic] } },
    {},
  );
  assert.notEqual(enriched, original);
  assert.equal(enriched.availability_overlay.effective, "QUESTIONABLE");
  assert.equal("availability_overlay" in original, false);
  assert.equal("confirmed_inactive" in enriched, false);
});

test("startup and focus refresh only stale or never-checked state", () => {
  assert.equal(shouldRefreshInjuries({ state: "stale" }), true);
  assert.equal(shouldRefreshInjuries({ state: "never_checked" }), true);
  assert.equal(shouldRefreshInjuries({ state: "fresh" }), false);
});

test("source-date freshness is distinct from cache freshness", () => {
  const status = normalizeInjuryStatus({ state: "stale_source", fresh: true, source_fresh: false, source_age_seconds: 200000 });
  assert.equal(status.fresh, true);
  assert.equal(status.sourceFresh, false);
  assert.equal(status.sourceAgeSeconds, 200000);
});

test("manual force refresh queues behind an automatic refresh instead of being swallowed", async () => {
  const calls = [];
  let release;
  const first = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async (_url, options) => {
    calls.push(options.headers["X-Force-Refresh"] || "auto");
    if (calls.length === 1) await first;
    return { ok: true, status: 200, json: async () => ({ state: "fresh" }) };
  };
  const automaticRequest = sharedCheck({ profile_id: "p" }, "", "p:2026", false, fetchImpl);
  const forcedRequest = sharedCheck({ profile_id: "p" }, "", "p:2026", true, fetchImpl);
  release();
  await Promise.all([automaticRequest, forcedRequest]);
  assert.deepEqual(calls, ["auto", "true"]);
});

test("availability badges use layout spacing instead of name whitespace", () => {
  const css = readFileSync(new URL("../src/styles/views.css", import.meta.url), "utf8");
  assert.match(css, /\.availability-badge\s*\{[^}]*margin-inline-start:\s*var\(--s-2\)/s);
});
