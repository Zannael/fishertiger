import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptSosFantaFormations,
  acceptSosFanta,
  applyPlayerList,
  checkSosFanta,
  checkSosFantaFormations,
  checkSosFantaSetPieces,
  checkSosFantaGoalkeepers,
  checkInjuries,
  checkAllUpdateSources,
  repairSosFantaFormationIdentities,
  getInjuryStatus,
  fantacalcioDownloadUrl,
  fetchSosFantaFormationBundle,
  sosFantaFormationsUrl,
  sosFantaGuideUrl,
  sosFantaPenaltyUrl,
  sosFantaSetPieceUrl,
  sosFantaGoalkeepersUrl,
  updateStateLabel,
  uploadPlayerListCandidate,
} from "../src/updates-client.js";

test("builds the SOS Fanta guide URL from the selected season", () => {
  assert.match(sosFantaGuideUrl("2026/27"), /2026-2027-tutti-consigli/);
  assert.equal(sosFantaGuideUrl("invalid"), "");
});

test("builds the exact season-aware SOS Fanta formations URL", () => {
  assert.equal(
    sosFantaFormationsUrl("2026/27"),
    "https://www.sosfanta.com/asta-fantacalcio/seriea-tutte-formazioni-tipo-fantacalcio-2026-2027-asta-consigli-chi-prendere/",
  );
  assert.equal(sosFantaFormationsUrl("2026/2027"), sosFantaFormationsUrl("2026/27"));
  assert.equal(sosFantaFormationsUrl("2026/28"), "");
  assert.equal(sosFantaFormationsUrl("invalid"), "");
});

test("uses the SOS Fanta formations provider endpoint", async () => {
  let requestUrl;
  const fetchImpl = async (url) => {
    requestUrl = url;
    return { ok: true, status: 200, json: async () => ({ state: "unchanged" }) };
  };
  await checkSosFantaFormations({ profile_id: "league" }, { fetchImpl });
  assert.equal(requestUrl, "/api/updates/sosfanta-formations/check");
});

test("builds the SOS Fanta set-piece URL and endpoint", async () => {
  assert.equal(
    sosFantaSetPieceUrl("2026/27"),
    "https://www.sosfanta.com/asta-fantacalcio/serie-a-2026-2027-tiratori-punizioni-corner-specialisti-fantacalcio-asta/",
  );
  assert.equal(sosFantaSetPieceUrl("2026/28"), "");
  assert.match(sosFantaPenaltyUrl(), /rigoristi-seriea-venti-squadre-campionato/);
  let requestUrl;
  const fetchImpl = async (url) => {
    requestUrl = url;
    return { ok: true, status: 200, json: async () => ({ state: "unchanged" }) };
  };
  await checkSosFantaSetPieces({ profile_id: "league" }, { fetchImpl });
  assert.equal(requestUrl, "/api/updates/sosfanta-set-pieces/check");
});

test("uses the SOS Fanta goalkeeper provider endpoint", async () => {
  assert.match(sosFantaGoalkeepersUrl(), /tutti-portieri-gerarchie-seriea/);
  let requestUrl;
  await checkSosFantaGoalkeepers({ profile_id: "league" }, {
    fetchImpl: async (url) => { requestUrl = url; return { ok: true, status: 200, json: async () => ({ state: "unchanged" }) }; },
  });
  assert.equal(requestUrl, "/api/updates/sosfanta-goalkeepers/check");
});

test("keeps Fantacalcio Online status and refresh behind backend endpoints", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => ({ state: "fresh" }) };
  };
  await getInjuryStatus({ profile_id: "league" }, { fetchImpl });
  await checkInjuries({ profile_id: "league" }, { fetchImpl });
  assert.deepEqual(urls, [
    "/api/updates/injuries/status",
    "/api/updates/injuries/check",
  ]);
  assert.equal(urls.every((url) => url.startsWith("/api/updates/injuries/")), true);
});

test("manual injury refresh explicitly bypasses the backend freshness guard", async () => {
  let headers;
  await checkInjuries({ profile_id: "league" }, {
    force: true,
    fetchImpl: async (_url, options) => {
      headers = options.headers;
      return { ok: true, status: 200, json: async () => ({ state: "fresh" }) };
    },
  });
  assert.equal(headers["X-Force-Refresh"], "true");
});

test("check-all tolerates one failure and only calls check endpoints", async () => {
  const urls = [];
  const rows = await checkAllUpdateSources({ profile_id: "league" }, {
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.includes("sosfanta-formations")) throw new Error("offline");
      return { ok: true, status: 200, json: async () => ({ state: "unchanged" }) };
    },
  });
  assert.equal(rows.length, 11);
  assert.equal(rows.at(-1).label, "FCO Contesto calendario");
  assert.equal(rows.filter((row) => row.error).length, 1);
  assert.equal(urls.every((url) => url.endsWith("/check")), true);
  assert.equal(urls.some((url) => url.includes("/apply") || url.includes("/accept")), false);
});

test("maps profile seasons to official Fantacalcio downloads", () => {
  assert.equal(fantacalcioDownloadUrl("2026/27"), "https://www.fantacalcio.it/api/v1/Excel/prices/21/1");
  assert.equal(fantacalcioDownloadUrl("2027/2028"), "https://www.fantacalcio.it/api/v1/Excel/prices/22/1");
  assert.equal(fantacalcioDownloadUrl("2026/28"), "");
});

test("uploads a candidate to the profile and season scoped endpoint", async () => {
  let request;
  const file = { name: "listone.xlsx" };
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, json: async () => ({ state: "candidate_ready" }) };
  };
  await uploadPlayerListCandidate(file, { profile_id: "league", season: { season: "2026/27" } }, { fetchImpl });
  assert.equal(request.url, "/api/updates/player-list/candidate/league/2026-27");
  assert.equal(request.options.headers["X-Filename"], "listone.xlsx");
  assert.equal(request.options.body, file);
});

test("sends the reviewed candidate hash when applying a listone", async () => {
  let body;
  const fetchImpl = async (_url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({ dataset_path: "league/2026-27/auction_data.json" }) };
  };
  await applyPlayerList({ profile_id: "league" }, "a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64), { fetchImpl });
  assert.equal(body.candidate_hash, "a".repeat(64));
  assert.equal(body.profile_hash, "b".repeat(64));
  assert.equal(body.active_hash, "c".repeat(64));
  assert.equal(body.starters_hash, "d".repeat(64));
});

test("sends the reviewed hash when accepting a snapshot", async () => {
  let body;
  const fetchImpl = async (_url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({ state: "unchanged" }) };
  };
  await acceptSosFanta({ profile_id: "test" }, { fetchImpl, contentHash: "abc" });
  assert.equal(body.content_hash, "abc");
});

test("sends both reviewed hashes when requesting a formations bundle", async () => {
  let body;
  const fetchImpl = async (_url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, status: 200 };
  };
  await fetchSosFantaFormationBundle(
    { profile_id: "test" },
    { fetchImpl, contentHash: "content", auditHash: "audit" },
  );
  assert.equal(body.content_hash, "content");
  assert.equal(body.audit_hash, "audit");
});

test("accepts a SOS Fanta formations source snapshot", async () => {
  let requestUrl;
  const fetchImpl = async (url) => {
    requestUrl = url;
    return { ok: true, status: 200, json: async () => ({ state: "unchanged" }) };
  };
  await acceptSosFantaFormations({ profile_id: "test" }, { fetchImpl, contentHash: "content" });
  assert.equal(requestUrl, "/api/updates/sosfanta-formations/accept");
});

test("sends the reviewed titolari hash for safe identity repairs", async () => {
  let request;
  await repairSosFantaFormationIdentities({ profile_id: "test" }, {
    auditHash: "reviewed-source-hash",
    fetchImpl: async (url, options) => { request = { url, body: JSON.parse(options.body) }; return { ok: true, status: 200, json: async () => ({ applied: 1 }) }; },
  });
  assert.equal(request.url, "/api/updates/sosfanta-formations/repair-identities");
  assert.equal(request.body.audit_hash, "reviewed-source-hash");
});

test("normalizes network and invalid response failures", async () => {
  await assert.rejects(
    checkSosFanta({}, { fetchImpl: async () => { throw new TypeError("offline"); } }),
    (error) => error.code === "network_error",
  );
  await assert.rejects(
    checkSosFanta({}, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError(); } }) }),
    (error) => error.code === "invalid_response",
  );
});

test("presents update states in Italian", () => {
  assert.equal(updateStateLabel("changed"), "Aggiornamenti disponibili");
  assert.equal(updateStateLabel(), "Non ancora verificato");
});

test("explains when the running backend needs to be restarted", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 404,
    json: async () => ({ error: { code: "not_found", message: "The requested endpoint does not exist." } }),
  });
  await assert.rejects(
    checkSosFanta({ profile_id: "test" }, { fetchImpl }),
    (error) => error.code === "backend_restart_required" && /Riavvialo/.test(error.message),
  );
});
