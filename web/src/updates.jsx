import { useEffect, useRef, useState } from "react";
import {
  acceptSosFanta,
  acceptSosFantaFormations,
  applySosFantaFormations,
  repairSosFantaFormationIdentities,
  acceptSosFantaSetPieces,
  applySosFantaGoalkeepers,
  applyPlayerList,
  checkPlayerList,
  checkSosFanta,
  checkSosFantaFormations,
  fantacalcioDownloadUrl,
  fetchSosFantaBundle,
  fetchSosFantaFormationBundle,
  fetchSosFantaSetPieceBundle,
  getPlayerListStatus,
  getSosFantaStatus,
  getSosFantaFormationStatus,
  getSosFantaSetPieceStatus,
  getSosFantaGoalkeeperStatus,
  playerListStateLabel,
  sosFantaGuideUrl,
  sosFantaFormationsUrl,
  sosFantaPenaltyUrl,
  sosFantaSetPieceUrl,
  sosFantaGoalkeepersUrl,
  checkSosFantaSetPieces,
  checkSosFantaGoalkeepers,
  checkAllUpdateSources,
  checkFco,
  getFcoStatus,
  uploadPlayerListCandidate,
  updateStateLabel,
} from "./updates-client.js";
import { injuryUpdateViewModel } from "./injury-state.js";

const ROLE_LABELS = { P: "Portieri", D: "Difensori", C: "Centrocampisti", A: "Attaccanti" };
const ActionIcon = ({ name }) => {
  const paths = {
    refresh: <path d="M20 11a8.1 8.1 0 0 0-14.8-4L3 10m0 0V4m0 6h6M4 13a8.1 8.1 0 0 0 14.8 4L21 14m0 0v6m0-6h-6" />,
    download: <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 20h16" />,
    check: <path d="m5 12 4 4L19 6" />,
  };
  return <svg className="action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">{paths[name]}</svg>;
};
const LISTONE_SUMMARY_LABELS = {
  added: "Nuovi", removed: "Rimossi", ceduti_added: "Nuovi ceduti",
  ceduti_removed: "Ceduti rientrati", role: "Ruoli", name: "Nomi",
  team: "Squadre", quotation: "Quotazioni", fvm: "FVM", starters_removed: "Righe titolari da rimuovere",
};
const FORMATION_AUDIT_LABELS = {
  candidates: "Candidati", corroborated: "Confermati", status_mismatch: "Stato diverso",
  missing_row: "Righe mancanti", unresolved_identity: "Identità irrisolte",
  duplicate_row: "Righe duplicate", invalid_status: "Stati non validi",
  source_structure: "Struttura fonte", issue_count: "Problemi",
};
const displayChangeValue = (value) => value && typeof value === "object"
  ? Object.entries(value).map(([key, item]) => `${key}: ${item}`).join(" · ")
  : String(value ?? "-");
const displayFormationSnapshot = (change, prefix) => {
  const formation = change?.[`${prefix}_formation`];
  const value = change?.[`${prefix}_text`] ?? change?.[prefix === "old" ? "before" : "after"];
  const text = Array.isArray(value) ? value : value == null ? [] : [displayChangeValue(value)];
  return [formation, ...text].filter(Boolean).join("\n\n") || "-";
};

const HEALTH_LABELS = ["SOS Guida", "SOS Formazioni", "SOS Piazzati", "Listone", "SOS Portieri", "Disponibilità FCO", "FCO Prestazioni", "FCO Mercato", "FCO Probabili", "FCO Indici", "FCO Contesto calendario"];
const unresolvedBreakdown = (items = {}) => `fuori listone ${items.outside_active_listone || 0} · fuzzy ${items.fuzzy_requires_confirmation || 0} · ambigue ${items.ambiguous || 0} · squadra assente ${items.team_not_in_active_listone || 0} · altre ${items.other || 0}`;

function UpdateHealth({ profile, apiBase }) {
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const checkAll = async () => { setBusy(true); setRows(await checkAllUpdateSources(profile, { apiBase })); setBusy(false); };
  return (
    <article className="update-source-card update-health-card">
      <header><div><h2>Salute aggiornamenti</h2></div></header>
      <div className="update-actions"><button className="update-check-button" onClick={checkAll} disabled={busy}><ActionIcon name="refresh" /><span>{busy ? "Controllo..." : "Controlla tutte le fonti"}</span></button></div>
      <div className="listone-entry-list">
        {(rows.length ? rows : HEALTH_LABELS.map((label) => ({ label }))).map(({ label, result, error }) => {
          const issues = result?.audit?.summary?.issue_count || 0;
          const records = result?.snapshot?.source_count;
          const unresolved = result?.snapshot?.unresolved?.length;
          const fco = label === "FCO Prestazioni" && result ? `${result.available_matchdays} giornate · ${result.final_matchdays} finali / ${result.provisional_matchdays} provvisorie · ${result.unresolved} irrisolti (${unresolvedBreakdown(result.unresolved_classifications)}) · ${result.cumulative_audit?.discrepancies?.length || 0} discrepanze confermate · ${result.cumulative_audit?.pending_sync?.length || 0} sincronizzazioni provvisorie`
            : label === "FCO Mercato" && result ? `ownership ${result.market_source_date} · prezzi ${result.price_source_date} · ${result.summary?.players || 0} giocatori · ${result.summary?.current_season_prices || 0} correnti / ${result.summary?.fallback_prices || 0} fallback · ${unresolvedBreakdown(result.summary?.unresolved_classifications)}`
              : label === "FCO Probabili" && result ? `G${result.matchday} · ${result.active_source_count}/4 fonti · ${result.evaluated_players} valutati · ${result.unresolved?.length || 0} irrisolti (${unresolvedBreakdown(result.unresolved_classifications)})`
                : label === "FCO Indici" && result ? `${result.source_date} · ${result.source_rows} righe · ${result.resolved} risolti / ${result.unresolved?.length || 0} irrisolti (${unresolvedBreakdown(result.unresolved_classifications)})`
                  : label === "FCO Contesto calendario" && result ? `${result.calendar?.exact_matches || 0}/380 partite ufficiali · forza ${result.team_strength?.team_count || 0}/20 · ${result.near_term_markets?.fixture_count || 0} mercati correnti` : "";
          const detail = error || fco || (result ? `${updateStateLabel(result.state)}${issues ? ` · ${issues} problemi locali` : ""}${Number.isFinite(records) ? ` · ${records} record` : ""}${Number.isFinite(unresolved) ? ` · ${unresolved} irrisolti` : ""}` : "Non controllato");
          return <p key={label}><strong>{label}</strong><span>{detail}</span></p>;
        })}
      </div>
    </article>
  );
}

const fcoDetails = (result) => {
  const performance = result?.performance;
  const market = result?.market;
  const lineups = result?.lineups;
  const forecast = result?.forecast;
  const fixture = result?.fixture_context;
  return [
    ["FCO Prestazioni", performance
      ? `${performance.available_matchdays} giornate · ${performance.final_matchdays} finali / ${performance.provisional_matchdays} provvisorie · ${performance.resolved} risolti / ${performance.unresolved} irrisolti (${unresolvedBreakdown(performance.unresolved_classifications)}) · audit cumulativo: ${unresolvedBreakdown(performance.cumulative_audit?.unresolved_classifications)} · ${performance.cumulative_audit?.discrepancies?.length || 0} discrepanze confermate · ${performance.cumulative_audit?.pending_sync?.length || 0} sincronizzazioni provvisorie`
      : "Non ancora disponibili"],
    ["FCO Mercato", market
      ? `ownership ${market.market_source_date} · prezzi ${market.price_source_date} · ${market.summary?.players || 0} giocatori · ${market.summary?.current_season_prices || 0} prezzi correnti / ${market.summary?.fallback_prices || 0} fallback · ${market.summary?.unresolved || 0} irrisolti (${unresolvedBreakdown(market.summary?.unresolved_classifications)})`
      : "Non ancora disponibile"],
    ["FCO Probabili", lineups
      ? `G${lineups.matchday} · ${lineups.observation_at?.slice(0, 16).replace("T", " ")} · ${lineups.active_source_count}/4 fonti · ${lineups.evaluated_players} valutati · ${lineups.unresolved?.length || 0} irrisolti (${unresolvedBreakdown(lineups.unresolved_classifications)})`
      : "Non ancora disponibili"],
    ["FCO Indici", forecast
      ? `${forecast.source_date} · ${forecast.source_rows} righe · ${forecast.resolved} risolti / ${forecast.unresolved?.length || 0} irrisolti (${unresolvedBreakdown(forecast.unresolved_classifications)})`
      : "Non ancora disponibili"],
    ["FCO Contesto calendario", fixture
      ? `calendario ${fixture.calendar?.rounds}/38 giornate · ${fixture.calendar?.fixtures}/380 partite · ufficiale ${fixture.calendar?.state} · forza ${fixture.team_strength?.team_count}/20 (${fixture.team_strength?.semantic_label}) · quote correnti ${fixture.near_term_markets?.fixture_count || 0}${fixture.near_term_markets?.observation_at ? ` · ${fixture.near_term_markets.observation_at.slice(0, 16).replace("T", " ")}` : ""}`
      : "Non ancora disponibile"],
  ];
};

function FcoUpdates({ profile, apiBase }) {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    setResult(null);
    getFcoStatus(profile, { apiBase }).then((next) => active && setResult(next)).catch(() => {});
    return () => { active = false; };
  }, [apiBase, profile?.profile_id, profile?.season?.season]);
  const check = async () => {
    setBusy(true);
    setMessage("");
    try {
      const next = await checkFco(profile, { apiBase, force: true });
      setResult(next);
      setMessage(Object.keys(next.errors || {}).length ? "Alcune fonti non sono state aggiornate: l'ultimo snapshot valido è rimasto intatto." : "Fonti Fantacalcio Online aggiornate.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Controllo non completato.");
    } finally {
      setBusy(false);
    }
  };
  return <article className="update-source-card">
    <header><div><h2>Fantacalcio Online</h2></div><span className={`update-state ${result?.state || "idle"}`}>P1–P3</span></header>
    <div className="update-actions"><button className="update-check-button" onClick={check} disabled={busy}><ActionIcon name="refresh" /><span>{busy ? "Controllo in corso..." : "Aggiorna fonti FCO"}</span></button></div>
    <div className="listone-entry-list">{fcoDetails(result).map(([label, detail]) => <p key={label}><strong>{label}</strong><span>{detail}</span></p>)}</div>
    {result?.performance?.cumulative_audit?.discrepancies?.length ? <details className="injury-update-details"><summary>Discrepanze confermate <b>{result.performance.cumulative_audit.discrepancies.length}</b></summary><div className="listone-entry-list">{result.performance.cumulative_audit.discrepancies.map((item) => <p key={`${item.fantacalcio_id}-${item.metric}`}><strong>{item.canonical_name} · #{item.fantacalcio_id}</strong><span>{item.metric}: giornate finali {item.final_matchday_total} · cumulativo FCO {item.cumulative}</span></p>)}</div></details> : null}
    {result?.performance?.cumulative_audit?.pending_sync?.length ? <details className="injury-update-details"><summary>Sincronizzazioni provvisorie in attesa <b>{result.performance.cumulative_audit.pending_sync.length}</b></summary><div className="listone-entry-list">{result.performance.cumulative_audit.pending_sync.map((item) => <p key={`${item.fantacalcio_id}-${item.metric}`}><strong>{item.canonical_name} · #{item.fantacalcio_id}</strong><span>{item.metric}: finali {item.final_matchday_total} + provvisorio {item.provisional_addition} (G{item.provisional_matchdays.join(", G")}) · cumulativo FCO {item.cumulative}</span></p>)}</div></details> : null}
    {message && <p className="update-message" role="status">{message}</p>}
  </article>;
}

function PlayerListUpdates({ profile, apiBase, onApplyStart, onApplied }) {
  const [candidate, setCandidate] = useState(null);
  const [remote, setRemote] = useState(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [problem, setProblem] = useState("");
  const [confirmApply, setConfirmApply] = useState(false);
  const sequence = useRef(0);
  const season = profile?.season?.season;
  const downloadUrl = remote?.download_url || fantacalcioDownloadUrl(season);

  useEffect(() => {
    let active = true;
    const request = ++sequence.current;
    setCandidate(null);
    setRemote(null);
    setBusy("");
    setMessage("");
    setProblem("");
    getPlayerListStatus(profile, { apiBase })
      .then((next) => {
        if (active && request === sequence.current) setCandidate(next);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [apiBase, profile?.profile_id, season]);

  const check = async () => {
    const request = ++sequence.current;
    setBusy("check");
    setMessage("");
    setProblem("");
    try {
      const next = await checkPlayerList(profile, { apiBase });
      if (request !== sequence.current) return;
      setRemote(next);
      setMessage(next.state === "changed" ? "Il listone online contiene variazioni." : "Il listone online coincide con la fonte attiva.");
    } catch (error) {
      if (request !== sequence.current) return;
      setProblem(error?.code || "request_failed");
      setMessage(error instanceof Error ? error.message : "Controllo non completato.");
    } finally {
      if (request === sequence.current) setBusy("");
    }
  };

  const copyDownloadLink = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(downloadUrl);
      setProblem("");
      setMessage("Link copiato. Apri una nuova scheda, incollalo nella barra degli indirizzi e premi Invio.");
    } catch {
      window.prompt("Copia questo link, poi incollalo nella barra degli indirizzi di una nuova scheda:", downloadUrl);
    }
  };

  const upload = async (file) => {
    if (!file) return;
    const request = ++sequence.current;
    setBusy("upload");
    setMessage("");
    setProblem("");
    try {
      await uploadPlayerListCandidate(file, profile, { apiBase });
      const next = await getPlayerListStatus(profile, { apiBase });
      if (request !== sequence.current) return;
      setCandidate(next);
      setMessage(next.state === "unchanged" ? "Il file caricato coincide con il listone attivo." : "File verificato: esamina le differenze prima di applicarlo.");
    } catch (error) {
      if (request !== sequence.current) return;
      setProblem(error?.code || "request_failed");
      setMessage(error instanceof Error ? error.message : "Caricamento non completato.");
    } finally {
      if (request === sequence.current) setBusy("");
    }
  };

  const apply = async () => {
    const request = ++sequence.current;
    setBusy("apply");
    setMessage("");
    setProblem("");
    try {
      const profileRequest = onApplyStart?.();
      const result = await applyPlayerList(
        profile,
        candidate?.candidate_hash,
        candidate?.profile_hash,
        candidate?.active_hash,
        candidate?.starters_hash,
        { apiBase },
      );
      if (request !== sequence.current) return;
      if (onApplied && await onApplied(result, profileRequest) === false) return;
      if (request !== sequence.current) return;
      setCandidate((current) => ({ ...current, state: "unchanged", summary: {}, details: {} }));
      setRemote(null);
      const removed = result.starters_removed?.length || 0;
      setMessage(removed
        ? `Listone applicato, ${removed} righe cedute rimosse da titolari.csv e dataset rigenerato.`
        : "Listone applicato, profilo aggiornato e dataset rigenerato.");
    } catch (error) {
      if (request !== sequence.current) return;
      setProblem(error?.code || "request_failed");
      setMessage(error instanceof Error ? error.message : "Aggiornamento non completato.");
    } finally {
      if (request === sequence.current) setBusy("");
      setConfirmApply(false);
    }
  };

  const summary = candidate?.summary || {};
  const summaryItems = Object.entries(LISTONE_SUMMARY_LABELS).filter(([key]) => summary[key]);

  return (
    <article className="update-source-card player-list-card">
      <header>
        <div><span className="source-index">04</span><h2>Listone Fantacalcio</h2></div>
        <span className={`update-state ${candidate?.state || remote?.state || "idle"}`}>
          {candidate?.state && candidate.state !== "never_uploaded" ? playerListStateLabel(candidate.state) : playerListStateLabel(remote?.state)}
        </span>
      </header>

      <div className="update-source-meta">
        <div><span>Stagione</span><strong>{season}</strong></div>
        <div><span>Ambito</span><strong>Ruoli, squadre, quotazioni e FVM</strong></div>
        <div><span>File candidato</span><strong>{candidate?.uploaded_at?.slice(0, 16).replace("T", " ") || "Nessuno"}</strong></div>
      </div>

      <a className="source-url" href="https://www.fantacalcio.it/quotazioni-fantacalcio" target="_blank" rel="noreferrer">
        https://www.fantacalcio.it/quotazioni-fantacalcio
      </a>

      <div className="update-actions player-list-actions">
        <button className="update-check-button" onClick={check} disabled={Boolean(busy)}>
          {busy === "check" ? "Controllo in corso..." : "Controlla listone online"}
        </button>
        <button className="update-action-link" type="button" onClick={copyDownloadLink} disabled={!downloadUrl}>
          Copia link XLSX ufficiale
        </button>
        <label className={`update-file-button${busy ? " disabled" : ""}`}>
          {busy === "upload" ? "Verifica file..." : "Carica XLSX scaricato"}
          <input
            type="file"
            accept=".xlsx"
            disabled={Boolean(busy)}
            onChange={(event) => {
              upload(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </label>
        {candidate?.state === "candidate_ready" && (
          <button className="update-apply-button" onClick={() => setConfirmApply(true)} disabled={Boolean(busy) || Boolean(candidate.details?.truncated)}>
            {busy === "apply"
              ? "Rigenerazione in corso..."
              : candidate.summary?.starters_removed
                ? "Applica, pulisci titolari e rigenera"
                : "Applica e rigenera"}
          </button>
        )}
      </div>

      {confirmApply && (
        <div className="update-confirm" role="alertdialog" aria-modal="true" aria-labelledby="listone-update-title">
          <strong id="listone-update-title">Salvare l’asta e aggiornare il listone?</strong>
          <p>Creeremo un backup dell’asta prima della rigenerazione. Le assegnazioni verranno ripristinate automaticamente; solo eventuali giocatori non riconosciuti richiederanno una verifica.</p>
          <div>
            <button type="button" className="quiet" onClick={() => setConfirmApply(false)}>Annulla</button>
            <button type="button" className="update-apply-button" onClick={apply}>Crea backup e applica</button>
          </div>
        </div>
      )}

      <div className="player-list-status">
        {remote?.summary && (
          <div className="update-summary">
            <span>CONTROLLO ONLINE</span>
            <strong>{remote.summary.public_players} giocatori</strong>
            <p>{remote.summary.added} nuovi · {remote.summary.removed} rimossi · {remote.summary.changed} modificati</p>
          </div>
        )}
        {message && <p className={`update-message ${problem ? "error" : ""}`} role={problem ? "alert" : "status"}>{message}</p>}
        {candidate?.summary?.starters_removed > 0 && (
          <p className="accept-warning">
            Il foglio autorevole <code>Ceduti</code> conferma {candidate.summary.starters_removed} righe obsolete in <code>titolari.csv</code>. Saranno rimosse insieme all’applicazione del Listone; le identità non confermate resteranno invariate.
          </p>
        )}
        <p className="accept-warning">Il download ufficiale richiede una sessione Fantacalcio autenticata. Copia il link, incollalo nella barra degli indirizzi di una nuova scheda e premi Invio.</p>
      </div>

      {summaryItems.length > 0 && (
        <div className="update-diff">
          <div className="diff-title"><span>DIFF XLSX AUTOREVOLE</span><strong>{summary.changed_players || 0} giocatori modificati</strong></div>
          <div className="listone-summary-grid">
            {summaryItems.map(([key, label]) => <div key={key}><strong>{summary[key]}</strong><span>{label}</span></div>)}
          </div>
          {[
            ["added", "Giocatori aggiunti"],
            ["removed", "Giocatori rimossi"],
            ["ceduti_added", "Nuovi giocatori nel foglio Ceduti"],
            ["ceduti_removed", "Giocatori rimossi dal foglio Ceduti"],
            ["starters_removed", "Righe che saranno rimosse da titolari.csv"],
          ].map(([key, label]) => candidate.details?.[key]?.length > 0 && (
            <details key={key}>
              <summary><span>{label}</span><b>{candidate.details[key].length}</b></summary>
              <div className="listone-entry-list">
                {candidate.details[key].map((item) => {
                  const id = typeof item === "object" ? item.id : item;
                  const name = typeof item === "object" ? item.name : "";
                  const match = item.match_method === "authoritative_id"
                    ? "ID confermato"
                    : item.match_method === "exact_identity" ? "nome e squadra esatti" : "";
                  return <p key={`${key}-${id}`}><strong>{name || `ID ${id}`}</strong>{name && <span>{item.team ? `${item.team} · ` : ""}#{id}{match ? ` · ${match}` : ""}</span>}</p>;
                })}
              </div>
            </details>
          ))}
          {candidate.details?.changed?.map((change) => (
            <details key={change.id}>
              <summary><span>{change.name} <small>#{change.id}</small></span><b>{Object.keys(change.fields).join(", ")}</b></summary>
              <div className="listone-change-fields">
                {Object.entries(change.fields).map(([field, values]) => (
                  <p key={field}><strong>{field}</strong><span>{displayChangeValue(values.before)} → {displayChangeValue(values.after)}</span></p>
                ))}
              </div>
            </details>
          ))}
          {candidate.details?.truncated && (
            <p className="update-truncated" role="alert">Il diff supera il limite visualizzabile. Non applicare il file senza una revisione esterna completa.</p>
          )}
        </div>
      )}
    </article>
  );
}

function FormationUpdates({ profile, apiBase }) {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [problem, setProblem] = useState("");
  const sequence = useRef(0);
  const season = profile?.season?.season;
  const auditSourceSignature = ["starters", "player_list"]
    .map((name) => profile?.current_sources?.find((source) => source.name === name)?.path || "")
    .join("|");
  const sourceUrl = result?.source_url || sosFantaFormationsUrl(season);
  const auditSummary = result?.audit?.summary;
  const auditSources = result?.audit?.sources || {};
  const findings = result?.audit?.findings || [];
  const identityAudit = result?.audit?.identity_audit;

  useEffect(() => {
    let active = true;
    const request = ++sequence.current;
    setResult(null);
    setBusy("");
    setMessage("");
    setProblem("");
    getSosFantaFormationStatus(profile, { apiBase })
      .then((next) => {
        if (active && request === sequence.current) setResult(next);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [apiBase, profile?.profile_id, season, auditSourceSignature]);

  const run = async (action) => {
    const request = ++sequence.current;
    setBusy(action);
    setMessage("");
    setProblem("");
    try {
      if (action === "check") {
        const next = await checkSosFantaFormations(profile, { apiBase });
        if (request !== sequence.current) return;
        setResult(next);
        setMessage(next.state === "changed" ? `${next.change_count} formazioni modificate.` : "Fonte e audit CSV verificati.");
      } else if (action === "apply") {
        const next = await applySosFantaFormations(profile, { apiBase, contentHash: result?.content_hash, auditHash: result?.audit_hash });
        if (request !== sequence.current) return;
        setResult((current) => ({ ...current, ...next }));
        setMessage(`${next.applied_count} correzioni deterministiche applicate; audit rieseguito.`);
      } else if (action === "repair-identities") {
        await repairSosFantaFormationIdentities(profile, { apiBase, auditHash: identityAudit?.source_hash });
        const next = await getSosFantaFormationStatus(profile, { apiBase });
        if (request !== sequence.current) return;
        setResult(next);
        setMessage("Riparazioni ID deterministiche applicate; audit rieseguito.");
      } else {
        const next = await acceptSosFantaFormations(profile, { apiBase, contentHash: result?.content_hash });
        if (request !== sequence.current) return;
        setResult((current) => ({ ...current, ...next, changes: [], change_count: 0 }));
        setMessage("La versione della fonte è stata salvata come riferimento. Il CSV non è stato modificato.");
      }
    } catch (error) {
      if (request !== sequence.current) return;
      setProblem(error?.code || "request_failed");
      setMessage(error instanceof Error ? error.message : "Operazione non completata.");
    } finally {
      if (request === sequence.current) setBusy("");
    }
  };

  const downloadBundle = async () => {
    const request = ++sequence.current;
    setBusy("bundle");
    setMessage("");
    setProblem("");
    try {
      const response = await fetchSosFantaFormationBundle(profile, {
        apiBase,
        contentHash: result?.content_hash,
        auditHash: result?.audit_hash,
      });
      const blob = await response.blob();
      if (request !== sequence.current) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `sosfanta-formazioni-update-${season.replace("/", "-")}.txt`;
      link.click();
      URL.revokeObjectURL(url);
      setMessage("Bundle AI per titolari.csv scaricato.");
    } catch (error) {
      if (request !== sequence.current) return;
      setProblem(error?.code || "request_failed");
      setMessage(error instanceof Error ? error.message : "Download non completato.");
    } finally {
      if (request === sequence.current) setBusy("");
    }
  };

  return (
    <article className="update-source-card">
      <header>
        <div><span className="source-index">02</span><h2>SOS Fanta Formazioni</h2></div>
        <span className={`update-state ${auditSummary?.issue_count ? "warning" : result?.state || "idle"}`}>{updateStateLabel(result?.state)}{auditSummary?.issue_count ? ` · ${auditSummary.issue_count} problemi locali` : ""}</span>
      </header>
      <div className="update-source-meta">
        <div><span>Stagione</span><strong>{season}</strong></div>
        <div><span>Ambito</span><strong>Formazioni tipo e audit titolari.csv</strong></div>
        <div><span>Ultimo controllo</span><strong>{result?.checked_at?.slice(0, 16).replace("T", " ") || "Mai"}</strong></div>
      </div>
      <a className="source-url" href={sourceUrl} target="_blank" rel="noreferrer">{sourceUrl}</a>
      <div className="update-actions">
         <button className="update-check-button" onClick={() => run("check")} disabled={Boolean(busy)}>
           <ActionIcon name="refresh" />
           <span>{busy === "check" ? "Controllo in corso..." : "Controlla formazioni"}</span>
         </button>
         {result?.bundle_available && (
           <button className="update-download-button" onClick={downloadBundle} disabled={Boolean(busy)}>
             <ActionIcon name="download" />
             <span>{busy === "bundle" ? "Preparazione..." : "Scarica bundle AI"}</span>
           </button>
         )}
         {(auditSummary?.missing_row || auditSummary?.status_mismatch) > 0 && (
           <button className="update-accept-button" onClick={() => run("apply")} disabled={Boolean(busy)}>
             <ActionIcon name="check" />
             <span>{busy === "apply" ? "Applicazione..." : "Applica correzioni sicure"}</span>
           </button>
         )}
         {identityAudit?.safe_repair_count > 0 && (
           <button className="update-accept-button" onClick={() => run("repair-identities")} disabled={Boolean(busy)}>
             <ActionIcon name="check" />
             <span>{busy === "repair-identities" ? "Riparazione..." : `Applica ${identityAudit.safe_repair_count} riparazioni ID sicure`}</span>
           </button>
         )}
         {(result?.state === "baseline_missing" || result?.state === "changed") && (
           <button className="update-accept-button quiet" onClick={() => run("accept")} disabled={Boolean(busy)}>
             <ActionIcon name="check" />
             <span>{result.state === "baseline_missing" ? "Salva riferimento iniziale" : "Segna fonte come acquisita"}</span>
           </button>
        )}
      </div>
      <p className="accept-warning">L’accettazione riconosce solo lo stato della fonte remota. <code>titolari.csv</code> non viene modificato automaticamente: revisiona separatamente l’audit CSV e applica le correzioni necessarie.</p>
      {message && <p className={`update-message ${problem ? "error" : ""}`} role={problem ? "alert" : "status"}>{message}</p>}

      {result && (
        <div className="update-summary">
          <span>STATO FONTE REMOTA</span>
          <strong>{updateStateLabel(result.state)}</strong>
          <p>{result.change_count || 0} modifiche semantiche rilevate</p>
        </div>
      )}
      {result?.changes?.length > 0 && (
        <div className="update-diff">
          <div className="diff-title"><span>DIFF FONTE REMOTA</span><strong>{result.change_count} squadre</strong></div>
          {result.changes.map((change, index) => (
            <details key={`${change.team || "formazione"}-${index}`}>
              <summary><span>{change.team || "Formazione"}</span><b>{change.change || change.kind || "modificata"}</b></summary>
              <div className="diff-columns">
                <div><small>PRIMA</small><p>{displayFormationSnapshot(change, "old")}</p></div>
                <div><small>DOPO</small><p>{displayFormationSnapshot(change, "new")}</p></div>
              </div>
            </details>
          ))}
        </div>
      )}

      {auditSummary && (
        <div className="update-diff">
          <div className="diff-title"><span>AUDIT CSV</span><strong>{auditSummary.issue_count || 0} problemi</strong></div>
          <div className="update-source-meta">
            <div><span>Titolari attivi</span><strong><code>{auditSources.starters?.path || "-"}</code></strong></div>
            <div><span>Listone attivo</span><strong><code>{auditSources.player_list?.path || "-"}</code></strong></div>
            <div><span>Versioni</span><strong><code>{auditSources.starters?.sha256?.slice(0, 8) || "-"} / {auditSources.player_list?.sha256?.slice(0, 8) || "-"}</code></strong></div>
          </div>
          <p className="accept-warning">L’audit usa esclusivamente queste fonti attive del profilo. Per sostituirle carica i file in Impostazioni e salva o rigenera il profilo; modificare una copia con un percorso diverso non aggiorna l’audit.</p>
          <div className="listone-summary-grid">
            {Object.entries(FORMATION_AUDIT_LABELS).map(([key, label]) => (
              <div key={key}><strong>{auditSummary[key] || 0}</strong><span>{label}</span></div>
            ))}
          </div>
          {findings.map((finding, index) => (
            <details key={`${finding.team}-${finding.id_fantacalcio || finding.name}-${index}`}>
              <summary><span>{finding.team || "Squadra non risolta"}</span><b>{finding.issue || "problema"}</b></summary>
              <div className="listone-change-fields">
                <p><strong>Stato</strong><span>{finding.current_status || "-"} → {finding.expected_status || "-"}</span></p>
                <p><strong>Giocatore</strong><span>{finding.name || finding.current_name || "-"}</span></p>
                <p><strong>Match</strong><span>{finding.match_method || "-"} · score {finding.match_score ?? "-"}</span></p>
                <p><strong>Articolo</strong><span>{finding.source === "article" ? finding.name : "-"}{finding.id_fantacalcio ? ` · ID ${finding.id_fantacalcio}` : ""}</span></p>
                {finding.best_candidate && <p><strong>Miglior candidato</strong><span>{finding.best_candidate} · {finding.match_score}</span></p>}
                {(finding.current_name || finding.source === "current_csv") && <p><strong>Nome CSV</strong><span>{finding.current_name || finding.name}</span></p>}
                {finding.diagnostic && <p><strong>Diagnostica</strong><span>{finding.diagnostic}</span></p>}
                {finding.duplicate_rows?.map((row) => <p key={row.row}><strong>Riga CSV {row.row}</strong><span>{row.name} · ID {row.id_fantacalcio || "-"} · {row.team} · {row.status} · {row.note || "nessuna nota"}</span></p>)}
                {finding.merge_reason && <p><strong>Merge</strong><span>{finding.merge_reason}</span></p>}
                {finding.formation_text && <p><strong>Formazione</strong><span>{finding.formation_text}</span></p>}
                {finding.ballot_text && <p><strong>Ballottaggio</strong><span>{finding.ballot_text}</span></p>}
              </div>
            </details>
          ))}
        </div>
      )}
    </article>
  );
}

function SetPieceUpdates({ profile, apiBase }) {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [problem, setProblem] = useState("");
  const sequence = useRef(0);
  const season = profile?.season?.season;
  const sourceUrls = result?.source_urls || [sosFantaSetPieceUrl(season), sosFantaPenaltyUrl()];

  useEffect(() => {
    let active = true;
    const request = ++sequence.current;
    setResult(null);
    setBusy("");
    setMessage("");
    setProblem("");
    getSosFantaSetPieceStatus(profile, { apiBase })
      .then((next) => {
        if (active && request === sequence.current) setResult(next);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [apiBase, profile?.profile_id, season]);

  const run = async (action) => {
    const request = ++sequence.current;
    setBusy(action);
    setMessage("");
    setProblem("");
    try {
      if (action === "check") {
        const next = await checkSosFantaSetPieces(profile, { apiBase });
        if (request !== sequence.current) return;
        setResult(next);
        setMessage(next.state === "changed" ? `${next.change_count} squadre modificate.` : "Verifica completata.");
      } else {
        const next = await acceptSosFantaSetPieces(profile, { apiBase, contentHash: result?.content_hash });
        if (request !== sequence.current) return;
        setResult((current) => ({ ...current, ...next, changes: [], change_count: 0 }));
        setMessage("La versione verificata è stata salvata come riferimento.");
      }
    } catch (error) {
      if (request !== sequence.current) return;
      setProblem(error?.code || "request_failed");
      setMessage(error instanceof Error ? error.message : "Operazione non completata.");
    } finally {
      if (request === sequence.current) setBusy("");
    }
  };

  const downloadBundle = async () => {
    const request = ++sequence.current;
    setBusy("bundle");
    setMessage("");
    setProblem("");
    try {
      const response = await fetchSosFantaSetPieceBundle(profile, { apiBase, contentHash: result?.content_hash });
      const blob = await response.blob();
      if (request !== sequence.current) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `sosfanta-piazzati-update-${season.replace("/", "-")}.txt`;
      link.click();
      URL.revokeObjectURL(url);
      setMessage("Bundle AI per piazzati.csv scaricato.");
    } catch (error) {
      if (request !== sequence.current) return;
      setProblem(error?.code || "request_failed");
      setMessage(error instanceof Error ? error.message : "Download non completato.");
    } finally {
      if (request === sequence.current) setBusy("");
    }
  };

  const hierarchy = (specialties) => Object.entries(specialties || {})
    .map(([type, players]) => `${type}: ${players.join(", ")}`).join("\n");

  return (
    <article className="update-source-card">
      <header>
        <div><span className="source-index">03</span><h2>SOS Fanta Piazzati</h2></div>
        <span className={`update-state ${result?.state || "idle"}`}>{updateStateLabel(result?.state)}</span>
      </header>
      <div className="update-source-meta">
        <div><span>Stagione</span><strong>{season}</strong></div>
        <div><span>Ambito</span><strong>Rigori, punizioni e corner</strong></div>
        <div><span>Ultimo controllo</span><strong>{result?.checked_at?.slice(0, 16).replace("T", " ") || "Mai"}</strong></div>
      </div>
      {sourceUrls.map((sourceUrl) => (
        <a className="source-url" href={sourceUrl} target="_blank" rel="noreferrer" key={sourceUrl}>{sourceUrl}</a>
      ))}
      <div className="update-actions">
        <button className="update-check-button" onClick={() => run("check")} disabled={Boolean(busy)}>
          {busy === "check" ? "Controllo in corso..." : "Controlla gerarchie"}
        </button>
         {result?.state === "changed" && (
           <button className="update-download-button" onClick={downloadBundle} disabled={Boolean(busy)}>
             <ActionIcon name="download" />
             <span>{busy === "bundle" ? "Preparazione..." : "Scarica bundle AI"}</span>
           </button>
         )}
         {(result?.state === "baseline_missing" || result?.state === "changed") && (
           <button className="update-accept-button quiet" onClick={() => run("accept")} disabled={Boolean(busy)}>
             <ActionIcon name="check" />
             <span>{result.state === "baseline_missing" ? "Salva riferimento iniziale" : "Segna come acquisito"}</span>
           </button>
        )}
      </div>
      <p className="accept-warning">Il controllo combina le gerarchie della pagina rigoristi con quelle di punizioni e corner. Segna come acquisito solo dopo aver revisionato <code>piazzati.csv</code>.</p>
      {message && <p className={`update-message ${problem ? "error" : ""}`} role={problem ? "alert" : "status"}>{message}</p>}
      {result?.changes?.length > 0 && (
        <div className="update-diff">
          <div className="diff-title"><span>DIFF GERARCHIE</span><strong>{result.change_count} squadre</strong></div>
          {result.changes.map((change) => (
            <details key={change.team}>
              <summary><span>{change.team}</span><b>{change.change}</b></summary>
              <div className="diff-columns">
                <div><small>PRIMA</small><p>{hierarchy(change.old_specialties) || "-"}{change.old_text.length ? `\n\n${change.old_text.join("\n\n")}` : ""}</p></div>
                <div><small>DOPO</small><p>{hierarchy(change.new_specialties) || "-"}{change.new_text.length ? `\n\n${change.new_text.join("\n\n")}` : ""}</p></div>
              </div>
            </details>
          ))}
        </div>
      )}
    </article>
  );
}

function GoalkeeperUpdates({ profile, apiBase }) {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [problem, setProblem] = useState("");
  const sequence = useRef(0);
  const season = profile?.season?.season;
  const sourceUrl = result?.source_url || sosFantaGoalkeepersUrl();

  useEffect(() => {
    let active = true;
    const request = ++sequence.current;
    getSosFantaGoalkeeperStatus(profile, { apiBase }).then((next) => {
      if (active && request === sequence.current) setResult(next);
    }).catch(() => {});
    return () => { active = false; };
  }, [apiBase, profile?.profile_id, season]);

  const run = async (action) => {
    const request = ++sequence.current;
    setBusy(action); setMessage(""); setProblem("");
    try {
      const options = { apiBase, contentHash: result?.content_hash };
      const next = action === "check"
        ? await checkSosFantaGoalkeepers(profile, options)
        : await applySosFantaGoalkeepers(profile, options);
      if (request !== sequence.current) return;
      setResult((current) => ({ ...current, ...next, changes: action === "check" ? next.changes : [], change_count: action === "check" ? next.change_count : 0 }));
      setMessage(action === "apply" ? `titolari.csv aggiornato: ${next.updated_rows} righe verificate, ${next.added_rows} aggiunte; ${next.skipped?.length || 0} slot lasciati vuoti.` : next.state === "changed" ? `${next.change_count} squadre modificate.` : "Verifica completata.");
    } catch (error) {
      if (request !== sequence.current) return;
      setProblem(error?.code || "request_failed");
      setMessage(error instanceof Error ? error.message : "Operazione non completata.");
    } finally { if (request === sequence.current) setBusy(""); }
  };

  return (
    <article className="update-source-card">
      <header><div><span className="source-index">05</span><h2>SOS Fanta Gerarchie Portieri</h2></div><span className={`update-state ${result?.state || "idle"}`}>{updateStateLabel(result?.state)}</span></header>
      <div className="update-source-meta"><div><span>Stagione</span><strong>{season}</strong></div><div><span>Ambito</span><strong>Primo, secondo e terzo portiere</strong></div><div><span>Ultimo controllo</span><strong>{result?.checked_at?.slice(0, 16).replace("T", " ") || "Mai"}</strong></div></div>
      <a className="source-url" href={sourceUrl} target="_blank" rel="noreferrer">{sourceUrl}</a>
      <div className="update-actions">
        <button className="update-check-button" onClick={() => run("check")} disabled={Boolean(busy)}><ActionIcon name="refresh" /><span>{busy === "check" ? "Controllo in corso..." : "Controlla gerarchie"}</span></button>
        {result?.content_hash && <button className="update-download-button" onClick={() => run("apply")} disabled={Boolean(busy)}><ActionIcon name="check" /><span>{busy === "apply" ? "Applicazione..." : "Applica a titolari.csv"}</span></button>}
      </div>
      <p className="accept-warning">L’applicazione usa il listone come fonte principale: i portieri non ancora presenti restano slot vuoti e potranno essere acquisiti in un aggiornamento futuro.</p>
      {message && <p className={`update-message ${problem ? "error" : ""}`} role={problem ? "alert" : "status"}>{message}</p>}
      {result?.starters_path && <p className="update-message"><code>{result.starters_path}</code><br />SHA-256: <code>{result.starters_hash}</code></p>}
      {result?.skipped?.length > 0 && <div className="update-diff"><div className="diff-title"><span>SLOT VUOTI</span><strong>{result.skipped.length}</strong></div>{result.skipped.map((item) => <p key={`${item.team}-${item.rank}`}><strong>{item.team} · {item.rank}</strong> {item.value}</p>)}</div>}
      {result?.changes?.length > 0 && <div className="update-diff"><div className="diff-title"><span>DIFF GERARCHIE</span><strong>{result.change_count} squadre</strong></div>{result.changes.map((change) => <details key={change.team}><summary><span>{change.team}</span><b>{change.change}</b></summary><div className="diff-columns"><div><small>PRIMA</small><p>{JSON.stringify(change.old)}</p></div><div><small>DOPO</small><p>{JSON.stringify(change.new)}</p></div></div></details>)}</div>}
    </article>
  );
}

const INJURY_STATE_LABELS = {
  unconfigured: "Non configurato",
  never_checked: "Mai controllato",
  fresh: "Cache aggiornata",
  stale: "Cache scaduta",
  stale_source: "Fonte non aggiornata",
  unsupported: "Copertura non disponibile",
  error: "Errore aggiornamento",
};

const ageLabel = (seconds) => {
  if (!Number.isFinite(seconds)) return "Nessuna cache";
  if (seconds < 60) return "meno di un minuto";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
};

export function InjuryUpdates({ injuryState }) {
  const [busy, setBusy] = useState(false);
  const status = injuryState.status;
  const snapshot = status.snapshot;
  const view = injuryUpdateViewModel(status);
  const groups = {
    OUT: view.out,
    QUESTIONABLE: view.questionable,
  };
  const refresh = async () => {
    setBusy(true);
    try {
      await injuryState.refresh();
    } catch {
      /* Central state keeps the cached snapshot and exposes the warning. */
    } finally {
      setBusy(false);
    }
  };
  const rows = (players) => (
    <div className="listone-entry-list injury-update-list">
      {players.map((player) => (
        <p key={`${player.provider_team_name}-${player.provider_player_name}`}>
          <strong>{player.role ? `${player.role} · ` : ""}{player.fantacalcio_name}</strong>
          <span>{player.fantacalcio_team} · {player.reason || "Motivo non indicato"} · rientro {player.expected_return || "non indicato"} · {player.return_date_source || "fonte data non indicata"}</span>
        </p>
      ))}
    </div>
  );

  return (
    <article className="update-source-card injury-update-card">
      <header>
        <div><span className="source-index">06</span><h2>Disponibilità Serie A</h2></div>
        <span className={`update-state ${status.state}`}>{INJURY_STATE_LABELS[status.state]}</span>
      </header>
      <div className="update-source-meta">
        <div><span>Fonte</span><strong>{view.sourceLabel}</strong></div>
        <div><span>Ultimo controllo riuscito</span><strong>{snapshot?.checked_at?.slice(0, 16).replace("T", " ") || "Mai"}</strong></div>
        <div><span>Età cache</span><strong>{ageLabel(status.cacheAgeSeconds)}</strong></div>
        <div><span>Età data fonte</span><strong>{ageLabel(status.sourceAgeSeconds)}</strong></div>
      </div>
      <div className="update-actions">
        <button className="update-check-button" type="button" onClick={refresh} disabled={busy}>
          <ActionIcon name="refresh" />
          <span>{busy ? "Aggiornamento..." : "Aggiorna ora"}</span>
        </button>
      </div>
      {view.warningMessage ? (
        <p className="update-message error" role="alert">
          {view.warningMessage}
        </p>
      ) : null}
      <div className="update-summary">
        <span>DISPONIBILITÀ RISOLTE</span>
        <strong>{groups.OUT.length} OUT · {groups.QUESTIONABLE.length} DUBBIO</strong>
        <p>{view.unresolved.length} identità non risolte</p>
      </div>
      {groups.OUT.length ? <details className="injury-update-details"><summary>OUT <b>{groups.OUT.length}</b></summary>{rows(groups.OUT)}</details> : null}
      {groups.QUESTIONABLE.length ? <details className="injury-update-details"><summary>QUESTIONABLE <b>{groups.QUESTIONABLE.length}</b></summary>{rows(groups.QUESTIONABLE)}</details> : null}
      {view.unresolved.length ? (
        <details className="injury-update-details">
          <summary>Identità non risolte <b>{view.unresolved.length}</b></summary>
          <div className="listone-entry-list injury-update-list">
            {view.unresolved.map((player, index) => (
              <p key={`${player.provider_team_name}-${player.provider_player_name}-${index}`}>
                <strong>{player.provider_player_name}</strong>
                <span>{player.provider_team_name} · {player.reason_code || player.match_failure}{player.best_candidate ? ` · candidato ${player.best_candidate} (${player.best_score})` : ""}{player.second_candidate ? ` · secondo ${player.second_candidate} (${player.second_score})` : ""}</span>
              </p>
            ))}
          </div>
        </details>
      ) : null}
    </article>
  );
}

export function Updates({
  profile,
  apiBase = "",
  onPlayerListApplyStart,
  onPlayerListApplied,
  injuryState,
}) {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [problem, setProblem] = useState("");
  const requestSequence = useRef(0);
  const season = profile?.season?.season;
  const sourceUrl = result?.source_url || sosFantaGuideUrl(season);

  useEffect(() => {
    let active = true;
    const request = ++requestSequence.current;
    setResult(null);
    setBusy("");
    setMessage("");
    setProblem("");
    getSosFantaStatus(profile, { apiBase })
      .then((next) => {
        if (active && request === requestSequence.current) setResult(next);
      })
      .catch(() => {
        /* A missing or old backend is explained when the user starts a check. */
      });
    return () => {
      active = false;
    };
  }, [apiBase, profile?.profile_id, season]);

  const run = async (action) => {
    const request = ++requestSequence.current;
    setBusy(action);
    setMessage("");
    setProblem("");
    try {
      if (action === "check") {
        const next = await checkSosFanta(profile, { apiBase });
        if (request !== requestSequence.current) return;
        setResult(next);
        setMessage(next.state === "changed" ? `${next.change_count} sezioni modificate.` : "Verifica completata.");
      } else {
        const next = await acceptSosFanta(profile, { apiBase, contentHash: result?.content_hash });
        if (request !== requestSequence.current) return;
        setResult((current) => ({ ...current, ...next, changes: [], change_count: 0 }));
        setMessage("La versione verificata è stata salvata come riferimento.");
      }
    } catch (error) {
      if (request !== requestSequence.current) return;
      setProblem(error?.code || "request_failed");
      setMessage(error instanceof Error ? error.message : "Operazione non completata.");
    } finally {
      if (request === requestSequence.current) setBusy("");
    }
  };

  const downloadBundle = async () => {
    const request = ++requestSequence.current;
    setBusy("bundle");
    setMessage("");
    setProblem("");
    try {
      const response = await fetchSosFantaBundle(profile, { apiBase, contentHash: result?.content_hash });
      const blob = await response.blob();
      if (request !== requestSequence.current) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `sosfanta-update-${season.replace("/", "-")}.txt`;
      link.click();
      URL.revokeObjectURL(url);
      setMessage("Bundle AI scaricato.");
    } catch (error) {
      if (request !== requestSequence.current) return;
      setProblem(error?.code || "request_failed");
      setMessage(error instanceof Error ? error.message : "Download non completato.");
    } finally {
      if (request === requestSequence.current) setBusy("");
    }
  };

  return (
    <section className="updates-view">
      <div className="updates-heading">
        <span className="eyebrow">FONTI ESTERNE</span>
        <h1>Aggiornamenti</h1>
        <p>Controlla le fonti, verifica le differenze e applica solo gli aggiornamenti approvati.</p>
      </div>

      <UpdateHealth profile={profile} apiBase={apiBase} />

      <FcoUpdates profile={profile} apiBase={apiBase} />

      <div className="update-workflow" aria-label="Come usare gli aggiornamenti">
        <strong>Come funziona</strong>
        <ol>
          <li><b>Controlla</b><span>Confronta le fonti online con i dati attivi.</span></li>
          <li><b>Verifica</b><span>Esamina il diff semantico o il file XLSX ufficiale.</span></li>
          <li><b>Applica</b><span>Conferma esplicitamente prima di aggiornare e rigenerare.</span></li>
        </ol>
        <p>Questa funzione rileva e prepara gli aggiornamenti. Non modifica automaticamente <code>titolari.csv</code> o <code>piazzati.csv</code>.</p>
      </div>

      <article className="update-source-card">
        <header>
          <div>
            <span className="source-index">01</span>
            <h2>SOS Fanta</h2>
          </div>
          <span className={`update-state ${result?.state || "idle"}`}>{updateStateLabel(result?.state)}</span>
        </header>

        <div className="update-source-meta">
          <div><span>Stagione</span><strong>{season}</strong></div>
          <div><span>Ambito</span><strong>Guida asta, pagine 1-4</strong></div>
          <div><span>Ultimo controllo</span><strong>{result?.checked_at?.slice(0, 16).replace("T", " ") || "Mai"}</strong></div>
        </div>

        <a className="source-url" href={sourceUrl} target="_blank" rel="noreferrer">{sourceUrl}</a>

        <div className="update-actions">
           <button className="update-check-button" onClick={() => run("check")} disabled={Boolean(busy)}>
             <ActionIcon name="refresh" />
             <span>{busy === "check" ? "Controllo in corso..." : "Controlla aggiornamenti"}</span>
           </button>
           {result?.state === "changed" && (
             <button className="update-download-button" onClick={downloadBundle} disabled={Boolean(busy)}>
               <ActionIcon name="download" />
               <span>{busy === "bundle" ? "Preparazione..." : "Scarica bundle AI"}</span>
             </button>
           )}
           {(result?.state === "baseline_missing" || result?.state === "changed") && (
             <button className="update-accept-button quiet" onClick={() => run("accept")} disabled={Boolean(busy)}>
               <ActionIcon name="check" />
               <span>{result.state === "baseline_missing" ? "Salva riferimento iniziale" : "Segna come acquisito"}</span>
             </button>
          )}
        </div>
        {result?.state === "changed" && (
          <p className="accept-warning">Segna come acquisito solo dopo aver revisionato e applicato gli aggiornamenti necessari.</p>
        )}
        {problem === "backend_restart_required" && (
          <div className="update-error" role="alert">
            <strong>Backend da riavviare</strong>
            <p>{message}</p>
            <code>.venv/bin/python -m advisor.server --host 127.0.0.1 --port 8000</code>
          </div>
        )}
        {message && problem !== "backend_restart_required" && <p className={`update-message ${problem ? "error" : ""}`} role="status">{message}</p>}

        {result?.changes?.length > 0 && (
          <div className="update-diff">
            <div className="diff-title"><span>DIFF SEMANTICO</span><strong>{result.change_count} sezioni</strong></div>
            {result.changes.map((change, index) => (
              <details key={`${change.role}-${change.tier}-${index}`}>
                <summary>
                  <span>{ROLE_LABELS[change.role]} / {change.tier.replaceAll("_", " ")}</span>
                  <b>{change.change}</b>
                </summary>
                <div className="diff-columns">
                  <div><small>PRIMA</small><p>{change.old_text.join("\n\n") || change.old_players.join(", ") || "-"}</p></div>
                  <div><small>DOPO</small><p>{change.new_text.join("\n\n") || change.new_players.join(", ") || "-"}</p></div>
                </div>
              </details>
            ))}
          </div>
        )}
      </article>

      <FormationUpdates profile={profile} apiBase={apiBase} />

      <SetPieceUpdates profile={profile} apiBase={apiBase} />

      <GoalkeeperUpdates profile={profile} apiBase={apiBase} />

      <PlayerListUpdates
        profile={profile}
        apiBase={apiBase}
        onApplyStart={onPlayerListApplyStart}
        onApplied={onPlayerListApplied}
      />

      <InjuryUpdates injuryState={injuryState} />

      <aside className="update-method-note">
        <strong>Metodo</strong>
        <p>I controlli confrontano solo i contenuti editoriali rilevanti. Menu, pubblicità e notizie correlate vengono escluse dagli hash. Solo le azioni Applica modificano le fonti locali e rigenerano il dataset.</p>
      </aside>
    </section>
  );
}
