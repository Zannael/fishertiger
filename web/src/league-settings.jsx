import { useEffect, useRef, useState } from "react";
import { synchronizeFantasyRange } from "./league-settings-range.js";
import { participantsFromCalendar } from "./league-calendar-teams.js";
import { isValidProfileId } from "./profile-client.js";
import {
  exactTiePolicies,
  incompleteLineupPolicies,
  nominationPolicies,
  sourceFormats,
  supportedValues,
  tieBreakers,
} from "./league-settings-policies.js";
import { profileChangePolicy } from "./profile-change-policy.js";

const roles = ["P", "D", "C", "A"];
const roleBudgetLabels = {
  P: "Portieri",
  D: "Difensori",
  C: "Centrocampisti",
  A: "Attaccanti",
};
const standardFormations = [
  "3-4-3",
  "3-5-2",
  "4-3-3",
  "4-4-2",
  "4-5-1",
  "5-3-2",
  "5-4-1",
];
const extraFormations = [
  "2-1-7",
  "2-2-6",
  "2-3-5",
  "2-4-4",
  "2-5-3",
  "2-6-2",
  "2-7-1",
  "3-1-6",
  "3-2-5",
  "3-3-4",
  "3-6-1",
  "4-1-5",
  "4-2-4",
  "5-1-4",
  "5-2-3",
  "6-1-3",
  "6-2-2",
  "6-3-1",
];
const currentSources = [
  { name: "player_list", label: "Listone giocatori", path: "data/raw/listone_2026_27.xlsx", format: "xlsx", required: true },
  { name: "serie_a_calendar", label: "Calendario Serie A", path: "data/raw/calendario_2026_27.xlsx", format: "xlsx", required: true },
  { name: "teams", label: "Dati squadre", path: "data/raw/squadre.csv", format: "csv", required: true },
  { name: "starters", label: "Probabili titolari", path: "data/raw/titolari.csv", format: "csv", required: true },
  { name: "set_pieces", label: "Gerarchie piazzati", path: "data/raw/piazzati.csv", format: "csv", required: true },
  { name: "auction_guide", label: "Guida asta", path: "data/raw/guide_asta_sosfanta.csv", format: "csv", required: true },
  { name: "league_calendar", label: "Calendario della lega", path: "data/raw/calendario_lega.xlsx", format: "xlsx", required: false },
];
const historySources = [
  { name: "stats_2025_26", label: "Statistiche 2025/26", path: "data/raw/statistiche_2025_26.xlsx", format: "xlsx", required: true, season: "2025-26" },
  { name: "stats_2024_25", label: "Statistiche 2024/25", path: "data/raw/statistiche_2024_25.xlsx", format: "xlsx", required: true, season: "2024-25" },
  { name: "stats_2023_24", label: "Statistiche 2023/24", path: "data/raw/statistiche_2023_24.xlsx", format: "xlsx", required: true, season: "2023-24" },
];
const sourceLabels = Object.fromEntries(
  [...currentSources, ...historySources].map(({ name, label }) => [name, label]),
);
const mergeSources = (definitions, supplied = []) =>
  definitions.map(({ label: _label, ...definition }) => {
    const { label: _savedLabel, ...saved } =
      supplied.find((source) => source.name === definition.name) || {};
    return {
      ...definition,
      ...saved,
      name: definition.name,
      format: definition.format,
      required: definition.required,
    };
  });
const defaults = {
  schema_version: 1,
  profile_id: "league-profile",
  name: "",
  season: {
    season: "2026/27",
    serie_a_matchdays: 38,
    fantasy_matchdays: 38,
    fantasy_start_matchday: 1,
    fantasy_end_matchday: 38,
  },
  current_sources: currentSources,
  history_sources: historySources,
  participants: {
    team_names: ["La mia squadra", "Squadra 2"],
    user_team: "La mia squadra",
  },
  credits: { starting: 500, entry_fee_eur: 0 },
  roster_slots: { P: 3, D: 8, C: 8, A: 6 },
  formations: { allowed: ["3-4-3", "3-5-2", "4-3-3"] },
  bench_switch: {
    bench_roles: ["P", "P", "D", "D", "D", "C", "C", "C", "A", "A", "A"],
    mode: "Basic",
    max_substitutions: 3,
  },
  scoring: {
    goal: 3,
    assist: 1,
    yellow_card: -0.5,
    red_card: -1,
    own_goal: -2,
    goalkeeper_conceded_goal: -1,
  },
  virtual_goals: { threshold: 66, step: 5 },
  defense_modifier: {
    enabled: false,
    table_name: "standard",
    required_defenders: 4,
    tiers: [
      { minimum_average: 6, bonus: 0 },
      { minimum_average: 6.5, bonus: 1 },
      { minimum_average: 7, bonus: 3 },
    ],
  },
  standings: {
    win_points: 3,
    draw_points: 1,
    loss_points: 0,
    tie_breakers: ["goal_difference", "head_to_head", "season_fantasy_score"],
    exact_tie_policy: "shared_rank",
  },
  payouts: {
    prizes: [{ rank: 1, amount_eur: 0 }],
    unplaced_policy: "no_payout",
  },
  incomplete_lineup: { policy: "zero_score", score: 0 },
  auction: {
    minimum_bid: 1,
    bid_increment: 1,
    reserve_credits_per_open_slot: 1,
    nomination_policy: "call",
    role_budget_percentages: { P: 7, D: 18, C: 25, A: 50 },
    role_budget_flexibility_percent: 5,
  },
};

const clone = (value) => JSON.parse(JSON.stringify(value));
const mergeProfile = (profile = {}, leagueCalendar) => ({
  ...clone(defaults),
  ...profile,
  season: synchronizeFantasyRange({
    ...defaults.season,
    ...profile.season,
    ...(profile.season && !Object.hasOwn(profile.season, "fantasy_end_matchday")
      ? { fantasy_end_matchday: profile.season.fantasy_matchdays }
      : {}),
  }),
  participants: participantsFromCalendar(
    { ...defaults.participants, ...profile.participants },
    leagueCalendar,
  ),
  credits: { ...defaults.credits, ...profile.credits },
  roster_slots: { ...defaults.roster_slots, ...profile.roster_slots },
  formations: { ...defaults.formations, ...profile.formations },
  bench_switch: { ...defaults.bench_switch, ...profile.bench_switch },
  scoring: { ...defaults.scoring, ...profile.scoring },
  virtual_goals: { ...defaults.virtual_goals, ...profile.virtual_goals },
  defense_modifier: {
    ...defaults.defense_modifier,
    ...profile.defense_modifier,
  },
  standings: { ...defaults.standings, ...profile.standings },
  payouts: {
    ...defaults.payouts,
    ...profile.payouts,
    unplaced_policy: "no_payout",
  },
  incomplete_lineup: {
    ...defaults.incomplete_lineup,
    ...profile.incomplete_lineup,
  },
  auction: {
    ...defaults.auction,
    ...profile.auction,
    role_budget_percentages: {
      ...defaults.auction.role_budget_percentages,
      ...profile.auction?.role_budget_percentages,
    },
  },
  current_sources: mergeSources(currentSources, profile.current_sources),
  history_sources: mergeSources(historySources, profile.history_sources),
});
const number = (value) => Number(value);

function validate(profile) {
  const errors = [];
  const required = (value, label) => {
    if (!String(value ?? "").trim()) errors.push(`${label} è obbligatorio.`);
  };
  const positive = (value, label, zero = false) => {
    if (!Number.isFinite(value) || (zero ? value < 0 : value <= 0))
      errors.push(
        `${label} deve essere ${zero ? "maggiore o uguale a zero" : "maggiore di zero"}.`,
      );
  };
  required(profile.profile_id, "ID profilo");
  if (String(profile.profile_id ?? "").trim() && !isValidProfileId(profile.profile_id))
    errors.push(
      "L'ID profilo può contenere solo lettere, numeri, underscore e trattini.",
    );
  required(profile.name, "Nome del profilo");
  required(profile.season.season, "Stagione");
  positive(profile.season.serie_a_matchdays, "Giornate di Serie A");
  if (
    !Number.isInteger(profile.season.fantasy_start_matchday) ||
    !Number.isInteger(profile.season.fantasy_end_matchday) ||
    profile.season.fantasy_start_matchday < 1 ||
    profile.season.fantasy_start_matchday >
      profile.season.fantasy_end_matchday ||
    profile.season.fantasy_end_matchday > profile.season.serie_a_matchdays
  )
    errors.push(
      "Il calendario fantasy deve rientrare nelle giornate di Serie A.",
    );
  ["current_sources", "history_sources"].forEach((key) => {
    if (!profile[key].length)
      errors.push(
        `I dati ${key === "current_sources" ? "correnti" : "storici"} richiedono almeno una fonte.`,
      );
    profile[key].forEach((source, index) => {
      required(source.name, `Nome della fonte ${index + 1}`);
      required(source.path, `Percorso della fonte ${index + 1}`);
      if (!supportedValues(sourceFormats).has(source.format))
        errors.push(
          `Seleziona un formato supportato per la fonte ${index + 1}.`,
        );
    });
  });
  const teams = profile.participants.team_names.map((team) => team.trim());
  if (teams.length < 2) errors.push("Aggiungi almeno due squadre.");
  if (teams.some((team) => !team))
    errors.push("I nomi delle squadre non possono essere vuoti.");
  if (new Set(teams).size !== teams.length)
    errors.push("I nomi delle squadre devono essere univoci.");
  if (!teams.includes(profile.participants.user_team))
    errors.push("Scegli una delle squadre come tua squadra.");
  positive(profile.credits.starting, "Crediti iniziali");
  positive(profile.credits.entry_fee_eur, "Quota di iscrizione", true);
  roles.forEach((role) =>
    positive(profile.roster_slots[role], `Posti in rosa ${role}`),
  );
  if (!profile.formations.allowed.length)
    errors.push("Seleziona almeno un modulo.");
  const maximumStarters = profile.formations.allowed.reduce(
    (maximum, formation) => {
      const [D, C, A] = formation.split("-").map(Number);
      return { P: 1, D: Math.max(maximum.D, D), C: Math.max(maximum.C, C), A: Math.max(maximum.A, A) };
    },
    { P: 1, D: 0, C: 0, A: 0 },
  );
  roles.forEach((role) => {
    const benchSlots = profile.bench_switch.bench_roles.filter((benchRole) => benchRole === role).length;
    if (profile.roster_slots[role] < maximumStarters[role] + benchSlots)
      errors.push(
        `La rosa richiede almeno ${maximumStarters[role] + benchSlots} giocatori ${role}: ${maximumStarters[role]} titolari e ${benchSlots} riserve.`,
      );
  });
  if (profile.bench_switch.max_substitutions > profile.bench_switch.bench_roles.length)
    errors.push("Le sostituzioni massime non possono superare i posti in panchina.");
  positive(profile.scoring.goal, "Valore del gol");
  positive(profile.scoring.assist, "Valore dell'assist", true);
  Object.entries({
    yellow_card: "L'ammonizione",
    red_card: "L'espulsione",
    own_goal: "L'autogol",
    goalkeeper_conceded_goal: "Il gol subito dal portiere",
  }).forEach(([key, label]) => {
    if (profile.scoring[key] > 0)
      errors.push(`${label} deve essere zero o negativo.`);
  });
  positive(profile.virtual_goals.threshold, "Soglia dei gol virtuali");
  positive(profile.virtual_goals.step, "Incremento dei gol virtuali");
  positive(profile.defense_modifier.required_defenders, "Difensori richiesti");
  const tiers = profile.defense_modifier.tiers;
  if (
    !tiers.length ||
    tiers.some((tier) => tier.minimum_average <= 0 || tier.bonus < 0) ||
    tiers.some(
      (tier, index) =>
        index && tier.minimum_average <= tiers[index - 1].minimum_average,
    )
  )
    errors.push(
      "Le fasce difensive richiedono medie positive, univoche e crescenti, e bonus non negativi.",
    );
  if (
    profile.standings.win_points <= profile.standings.draw_points ||
    profile.standings.draw_points < profile.standings.loss_points ||
    !profile.standings.tie_breakers.length
  )
    errors.push(
      "La classifica richiede vittoria > pareggio >= sconfitta e almeno un criterio di spareggio.",
    );
  const unsupported = (value, choices, label) => {
    if (!supportedValues(choices).has(value))
      errors.push(
        `${label} non è supportata: seleziona una scelta disponibile.`,
      );
  };
  if (
    profile.standings.tie_breakers.some(
      (criterion) => !supportedValues(tieBreakers).has(criterion),
    ) ||
    new Set(profile.standings.tie_breakers).size !==
      profile.standings.tie_breakers.length
  )
    errors.push(
      "I criteri di spareggio devono essere supportati e senza duplicati.",
    );
  unsupported(
    profile.standings.exact_tie_policy,
    exactTiePolicies,
    "La politica per la parità esatta",
  );
  unsupported(
    profile.incomplete_lineup.policy,
    incompleteLineupPolicies,
    "La politica per la formazione incompleta",
  );
  unsupported(
    profile.auction.nomination_policy,
    nominationPolicies,
    "La politica di chiamata",
  );
  if (
    !profile.payouts.prizes.length ||
    profile.payouts.prizes.some(
      (prize, index) => prize.rank !== index + 1 || prize.amount_eur < 0,
    ) ||
    profile.payouts.prizes.length > teams.length
  )
    errors.push(
      "I premi devono coprire posizioni consecutive, essere non negativi e non superare il numero di squadre.",
    );
  if (
    profile.incomplete_lineup.policy === "zero_score" &&
    profile.incomplete_lineup.score !== 0
  )
    errors.push("Le formazioni a punteggio zero devono avere punteggio 0.");
  positive(profile.auction.minimum_bid, "L'offerta minima");
  positive(profile.auction.bid_increment, "Il rilancio minimo");
  positive(
    profile.auction.reserve_credits_per_open_slot,
    "Crediti riservati per posto libero",
    true,
  );
  const roleBudgetValues = roles.map(
    (role) => profile.auction.role_budget_percentages[role],
  );
  if (
    roleBudgetValues.some((value) => !Number.isFinite(value) || value < 0) ||
    Math.abs(roleBudgetValues.reduce((sum, value) => sum + value, 0) - 100) >
      0.001
  )
    errors.push("Le percentuali di budget per ruolo devono sommare a 100%.");
  if (
    !Number.isFinite(profile.auction.role_budget_flexibility_percent) ||
    profile.auction.role_budget_flexibility_percent < 0 ||
    profile.auction.role_budget_flexibility_percent > 100
  )
    errors.push("La flessibilità del budget deve essere compresa tra 0% e 100%.");
  return errors;
}

export function LeagueSettings({
  initialProfile,
  leagueCalendar,
  onSave,
  onGenerate,
  apiBase = "",
}) {
  const [profile, setProfile] = useState(() =>
    mergeProfile(initialProfile, leagueCalendar),
  );
  const [errors, setErrors] = useState([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [sourceStatuses, setSourceStatuses] = useState({});
  const changePolicy = profileChangePolicy(mergeProfile(initialProfile, leagueCalendar), profile);
  const errorRef = useRef(null);
  const endpoint = (path) => `${apiBase.replace(/\/$/, "")}${path}`;
  const sourceSignature = JSON.stringify(
    ["current_sources", "history_sources"].flatMap((group) =>
      profile[group].map((source) => [group, source.name, source.path]),
    ),
  );
  const sourcesReady = ["current_sources", "history_sources"].every((group) =>
    profile[group].every(
      (source) =>
        !source.required || sourceStatuses[`${group}:${source.name}`] === "present",
    ),
  );
  useEffect(() => {
    setProfile(mergeProfile(initialProfile, leagueCalendar));
  }, [initialProfile, leagueCalendar]);
  useEffect(() => {
    if (!changePolicy.dirty) return undefined;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [changePolicy.dirty]);
  useEffect(() => {
    if (initialProfile || !profile.profile_id) return undefined;
    const controller = new AbortController();
    fetch(endpoint(`/api/profiles/${encodeURIComponent(profile.profile_id)}`), {
      signal: controller.signal,
    })
      .then((response) =>
        response.ok ? response.json() : Promise.reject(response.status),
      )
      .then((data) => {
        setProfile(mergeProfile(data.profile ?? data, leagueCalendar));
        setStatus("Profilo caricato dall'API locale.");
      })
      .catch(() =>
        setStatus(
          "L'API locale dei profili non è disponibile. Puoi comunque configurare il profilo qui.",
        ),
      );
    return () => controller.abort();
  }, [apiBase, initialProfile]);
  useEffect(() => {
    const controller = new AbortController();
    const checking = Object.fromEntries(
      ["current_sources", "history_sources"].flatMap((group) =>
        profile[group].map((source) => [`${group}:${source.name}`, "checking"]),
      ),
    );
    setSourceStatuses(checking);
    fetch(endpoint("/api/sources/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profile),
      signal: controller.signal,
    })
      .then((response) =>
        response.ok ? response.json() : Promise.reject(response.status),
      )
      .then(({ sources }) => {
        setSourceStatuses(
          Object.fromEntries(
            sources.map((source) => [
              `${source.group}:${source.name}`,
              source.exists ? "present" : "missing",
            ]),
          ),
        );
      })
      .catch((error) => {
        if (error?.name !== "AbortError")
          setSourceStatuses(
            Object.fromEntries(
              Object.keys(checking).map((key) => [key, "unavailable"]),
            ),
          );
      });
    return () => controller.abort();
  }, [apiBase, sourceSignature]);
  const update = (path, value) =>
    setProfile((current) => {
      const next = clone(current);
      let target = next;
      path.slice(0, -1).forEach((key) => {
        target = target[key];
      });
      target[path.at(-1)] = value;
      return next;
    });
  const updateSeasonRange = (field, value) =>
    setProfile((current) => ({
      ...current,
      season: synchronizeFantasyRange(current.season, field, value),
    }));
  const input = (label, path, options = {}) => {
    const value = path.reduce((item, key) => item[key], profile);
    return (
      <label className="ls-field" key={options.key}>
        {label}
        <input
          type={options.type ?? "text"}
          value={value}
          min={options.min}
          step={options.step}
          disabled={options.disabled}
          title={options.title}
          onChange={(event) =>
            update(
              path,
              options.type === "number"
                ? number(event.target.value)
                : event.target.value,
            )
          }
          required={options.required}
        />
      </label>
    );
  };
  const choiceSelect = (label, path, choices, help) => {
    const value = path.reduce((item, key) => item[key], profile);
    const selectedChoice = choices.find((choice) => choice.value === value);
    const supported = Boolean(selectedChoice);
    return (
      <label className="ls-field ls-select">
        {label}
        <select
          value={value}
          title={selectedChoice?.help ?? help}
          aria-describedby={`${path.join("-")}-help`}
          onChange={(event) => update(path, event.target.value)}
        >
          {!supported && (
            <option value={value}>Valore non supportato da correggere</option>
          )}
          {choices.map((choice) => (
            <option key={choice.value} value={choice.value} title={choice.help}>
              {choice.label}
            </option>
          ))}
        </select>
        <span id={`${path.join("-")}-help`} className="ls-field-help">
          {supported
            ? `${selectedChoice.label}: ${selectedChoice.help}`
            : "Il valore salvato non è supportato. Scegli una delle opzioni disponibili prima di salvare."}
        </span>
      </label>
    );
  };
  const save = async (generate) => {
    const nextErrors = validate(profile);
    setErrors(nextErrors);
    if (nextErrors.length) {
      setStatus(
        "Correggi i problemi di configurazione evidenziati prima di continuare.",
      );
      requestAnimationFrame(() => errorRef.current?.focus());
      return;
    }
    setBusy(true);
    setStatus("");
    try {
      const callback = generate ? onGenerate : onSave;
      if (callback) {
        await callback(profile);
        setStatus(
          generate
            ? "Dati rigenerati per questo profilo."
            : changePolicy.action === "rerun_simulation"
              ? "Profilo salvato: riesegui la simulazione per aggiornare i risultati."
              : "Profilo aggiornato.",
        );
        return;
      }
      const route = generate
        ? "/api/generate"
        : `/api/profiles/${encodeURIComponent(profile.profile_id)}`;
      const response = await fetch(endpoint(route), {
        method: generate ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(generate ? { profile } : profile),
      });
      if (!response.ok)
        throw new Error(`L'API locale ha restituito ${response.status}`);
      setStatus(
        generate
          ? "Generazione richiesta correttamente."
          : "Profilo salvato correttamente.",
      );
    } catch (error) {
      setStatus(
        `Impossibile ${generate ? "generare" : "salvare"}: ${error.message}.`,
      );
    } finally {
      setBusy(false);
    }
  };
  const uploadSource = async (group, index, file) => {
    if (!file) return;
    const source = profile[group][index];
    const key = `${group}:${source.name}`;
    setSourceStatuses((current) => ({ ...current, [key]: "uploading" }));
    setStatus("");
    try {
      const response = await fetch(
        endpoint(
          `/api/uploads/${encodeURIComponent(profile.profile_id)}/${group}/${encodeURIComponent(source.name)}`,
        ),
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Filename": file.name,
          },
          body: file,
        },
      );
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload.error?.message || `Errore ${response.status}`);
      update([group, index, "path"], payload.path);
      setSourceStatuses((current) => ({ ...current, [key]: "present" }));
      setStatus(`${sourceLabels[source.name] || source.name}: file caricato correttamente.`);
    } catch (error) {
      setSourceStatuses((current) => ({ ...current, [key]: "missing" }));
      setStatus(`Impossibile caricare ${sourceLabels[source.name] || source.name}: ${error.message}.`);
    }
  };
  const sourceEditor = (key, title) => (
    <div className="ls-source-group">
      <div className="ls-subheading">
        <h3>{title}</h3>
        <span>I file previsti vengono verificati dall'API locale.</span>
      </div>
      {profile[key].map((source, index) => (
        <div className="ls-source" key={`${key}-${source.name}`}>
          <div className="ls-source-identity">
            <strong>{sourceLabels[source.name] || source.name}</strong>
            <span>
              {source.format.toUpperCase()} · {source.path.split(/[\\/]/).at(-1)}
            </span>
          </div>
          <span
            className={`ls-source-status ${sourceStatuses[`${key}:${source.name}`] || "checking"}`}
            role="status"
          >
            <i />
            {{
              checking: "Verifica...",
              present: "Presente",
              missing: "Mancante",
              uploading: "Caricamento...",
              unavailable: "Non verificabile",
            }[sourceStatuses[`${key}:${source.name}`] || "checking"]}
          </span>
          <label className="ls-upload">
            <input
              type="file"
              accept={`.${source.format}`}
              disabled={sourceStatuses[`${key}:${source.name}`] === "uploading"}
              onChange={(event) => {
                uploadSource(key, index, event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            <span>Scegli file</span>
          </label>
        </div>
      ))}
    </div>
  );
  return (
    <form
      className="league-settings"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        save(false);
      }}
    >
      <header className="ls-header">
        <p className="ls-kicker">Configurazione della lega</p>
        <h1>Regole, file e parametri</h1>
        <p>
          Definisci ogni regola che i giocatori sperimenteranno. I campi
          obbligatori vengono convalidati prima del salvataggio o della
          generazione.
        </p>
      </header>
      <p className="ls-status" role="status" aria-live="polite">
        {status}
      </p>
      {errors.length > 0 && (
        <div className="ls-errors" role="alert" tabIndex="-1" ref={errorRef}>
          <strong>
            Verifica {errors.length} problem{errors.length === 1 ? "a" : "i"}:
          </strong>
          <ul>
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      )}
      <fieldset>
        <legend>
          <span>01</span> Identità e dati
        </legend>
        <div className="ls-grid">
          {input("ID profilo", ["profile_id"], { required: true })}
          {input("Nome del profilo", ["name"], { required: true })}
          {input("Stagione", ["season", "season"], { required: true })}
          <label className="ls-field">
            Giornate di Serie A
            <input
              type="number"
              min="1"
              value={profile.season.serie_a_matchdays}
              onChange={(event) =>
                updateSeasonRange(
                  "serie_a_matchdays",
                  number(event.target.value),
                )
              }
            />
          </label>
          <div
            className="ls-range"
            aria-label="Intervallo del calendario fantasy"
          >
            <p className="ls-range-label">Calendario fantasy</p>
            <div
              className="ls-dual-range"
              style={{
                "--range-start": `${((profile.season.fantasy_start_matchday - 1) / Math.max(profile.season.serie_a_matchdays - 1, 1)) * 100}%`,
                "--range-end": `${((profile.season.fantasy_end_matchday - 1) / Math.max(profile.season.serie_a_matchdays - 1, 1)) * 100}%`,
              }}
            >
              <input
                className="ls-range-start"
                type="range"
                min="1"
                max={profile.season.fantasy_end_matchday}
                value={profile.season.fantasy_start_matchday}
                aria-label="Inizio del calendario fantasy"
                onChange={(event) =>
                  updateSeasonRange(
                    "fantasy_start_matchday",
                    number(event.target.value),
                  )
                }
              />
              <input
                className="ls-range-end"
                type="range"
                min={profile.season.fantasy_start_matchday}
                max={profile.season.serie_a_matchdays}
                value={profile.season.fantasy_end_matchday}
                aria-label="Fine del calendario fantasy"
                onChange={(event) =>
                  updateSeasonRange(
                    "fantasy_end_matchday",
                    number(event.target.value),
                  )
                }
              />
            </div>
            <div className="ls-range-values" aria-hidden="true">
              <span>
                Inizio: {profile.season.fantasy_start_matchday}a giornata
              </span>
              <span>Fine: {profile.season.fantasy_end_matchday}a giornata</span>
            </div>
            <p>
              {profile.season.fantasy_matchdays} giornate: dalla{" "}
              {profile.season.fantasy_start_matchday}a alla{" "}
              {profile.season.fantasy_end_matchday}a giornata di Serie A
            </p>
          </div>
        </div>
        {sourceEditor("current_sources", "Fonti della stagione corrente")}
        {sourceEditor("history_sources", "Fonti storiche")}
      </fieldset>
      <fieldset>
        <legend>
          <span>02</span> Lega e denaro
        </legend>
        <div className="ls-grid">
          {input("Crediti iniziali", ["credits", "starting"], {
            type: "number",
            min: 1,
          })}
          {input("Quota di iscrizione (EUR)", ["credits", "entry_fee_eur"], {
            type: "number",
            min: 0,
          })}
        </div>
        <div className="ls-subheading">
          <h3>Squadre</h3>
          <button
            type="button"
            className="ls-text-button"
            onClick={() =>
              update(
                ["participants", "team_names"],
                [
                  ...profile.participants.team_names,
                  `Squadra ${profile.participants.team_names.length + 1}`,
                ],
              )
            }
          >
            Aggiungi squadra
          </button>
        </div>
        <div className="ls-team-list">
          {profile.participants.team_names.map((team, index) => (
            <div className="ls-team" key={index}>
              <label>
                Squadra {index + 1}
                <input
                  value={team}
                  onChange={(e) => {
                    const names = [...profile.participants.team_names];
                    names[index] = e.target.value;
                    update(["participants", "team_names"], names);
                    if (team === profile.participants.user_team)
                      update(["participants", "user_team"], e.target.value);
                  }}
                />
              </label>
              <button
                type="button"
                className="ls-remove"
                disabled={profile.participants.team_names.length === 2}
                onClick={() =>
                  update(
                    ["participants", "team_names"],
                    profile.participants.team_names.filter(
                      (_, item) => item !== index,
                    ),
                  )
                }
              >
                Rimuovi
              </button>
            </div>
          ))}
        </div>
        <label className="ls-field ls-select">
          La tua squadra
          <select
            value={profile.participants.user_team}
            onChange={(e) =>
              update(["participants", "user_team"], e.target.value)
            }
          >
            {profile.participants.team_names.map((team, index) => (
              <option key={index} value={team}>
                {team || `Squadra ${index + 1}`}
              </option>
            ))}
          </select>
        </label>
        <div className="ls-subheading">
          <h3>Premi</h3>
          <button
            type="button"
            className="ls-text-button"
            disabled={
              profile.payouts.prizes.length ===
              profile.participants.team_names.length
            }
            onClick={() =>
              update(
                ["payouts", "prizes"],
                [
                  ...profile.payouts.prizes,
                  { rank: profile.payouts.prizes.length + 1, amount_eur: 0 },
                ],
              )
            }
          >
            Aggiungi posizione
          </button>
        </div>
        <div className="ls-payouts">
          {profile.payouts.prizes.map((prize, index) => (
            <label key={prize.rank}>
              Posizione {prize.rank}
              <input
                type="number"
                min="0"
                value={prize.amount_eur}
                onChange={(e) => {
                  const prizes = clone(profile.payouts.prizes);
                  prizes[index].amount_eur = number(e.target.value);
                  update(["payouts", "prizes"], prizes);
                }}
              />
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>
          <span>03</span> Rosa e sostituzioni
        </legend>
        <div className="ls-slots">
          {roles.map((role) =>
            input(`Posti ${role}`, ["roster_slots", role], {
              type: "number",
              min: 1,
            }),
          )}
        </div>
        <div className="ls-subheading">
          <h3>Panchina e sostituzioni</h3>
          <span>La simulazione usa questa composizione e il limite globale indicato.</span>
        </div>
        <div className="ls-slots">
          {roles.map((role) => (
            <label key={`bench-${role}`}>
              Panchina {role}
              <input
                type="number"
                min="0"
                value={profile.bench_switch.bench_roles.filter((benchRole) => benchRole === role).length}
                onChange={(event) => {
                  const parsed = number(event.target.value);
                  const count = Number.isInteger(parsed) ? Math.max(0, parsed) : 0;
                  const remaining = profile.bench_switch.bench_roles.filter((benchRole) => benchRole !== role);
                  update(["bench_switch", "bench_roles"], [...remaining, ...Array(count).fill(role)]);
                }}
              />
            </label>
          ))}
          {input("Sostituzioni massime", ["bench_switch", "max_substitutions"], { type: "number", min: 0 })}
          <label>
            Modalità sostituzioni
            <select
              value={profile.bench_switch.mode}
              onChange={(event) => update(["bench_switch", "mode"], event.target.value)}
            >
              <option value="Basic">Basic</option>
              <option value="Strict">Strict</option>
              <option value="None">Nessuna</option>
            </select>
          </label>
        </div>
        <div className="ls-subheading">
          <h3>Moduli consentiti</h3>
          <span>Seleziona tutti i moduli consentiti dalla tua lega.</span>
        </div>
        {[
          ["Moduli standard", standardFormations],
          ["Moduli extra", extraFormations],
        ].map(([title, group]) => {
          const selected = group.every((formation) =>
            profile.formations.allowed.includes(formation),
          );
          return (
            <div
              className="ls-formation-group"
              key={title}
              role="group"
              aria-label={title}
            >
              <div className="ls-subheading">
                <h4>{title}</h4>
                <button
                  type="button"
                  className="ls-text-button"
                  onClick={() =>
                    update(
                      ["formations", "allowed"],
                      selected
                        ? profile.formations.allowed.filter(
                            (formation) => !group.includes(formation),
                          )
                        : [
                            ...profile.formations.allowed,
                            ...group.filter(
                              (formation) =>
                                !profile.formations.allowed.includes(formation),
                            ),
                          ],
                    )
                  }
                >
                  {selected ? "Deseleziona tutti" : "Seleziona tutti"}
                </button>
              </div>
              <div className="ls-options">
                {group.map((formation) => (
                  <label className="ls-check" key={formation}>
                    <input
                      type="checkbox"
                      checked={profile.formations.allowed.includes(formation)}
                      onChange={(e) =>
                        update(
                          ["formations", "allowed"],
                          e.target.checked
                            ? [...profile.formations.allowed, formation]
                            : profile.formations.allowed.filter(
                                (item) => item !== formation,
                              ),
                        )
                      }
                    />
                    {formation}
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </fieldset>
      <fieldset>
        <legend>
          <span>04</span> Punteggi e modificatori
        </legend>
        <div className="ls-grid ls-score">
          {input("Gol", ["scoring", "goal"], { type: "number", step: "0.1" })}
          {input("Assist", ["scoring", "assist"], {
            type: "number",
            step: "0.1",
          })}
          {input("Ammonizione", ["scoring", "yellow_card"], {
            type: "number",
            step: "0.1",
          })}
          {input("Espulsione", ["scoring", "red_card"], {
            type: "number",
            step: "0.1",
          })}
          {input("Autogol", ["scoring", "own_goal"], {
            type: "number",
            step: "0.1",
          })}
          {input(
            "Gol subito dal portiere",
            ["scoring", "goalkeeper_conceded_goal"],
            { type: "number", step: "0.1" },
          )}
          {input("Soglia dei gol virtuali", ["virtual_goals", "threshold"], {
            type: "number",
            step: "0.1",
          })}
          {input("Incremento dei gol virtuali", ["virtual_goals", "step"], {
            type: "number",
            step: "0.1",
          })}
        </div>
        <label className="ls-check ls-toggle">
          <input
            type="checkbox"
            checked={profile.defense_modifier.enabled}
            onChange={(e) =>
              update(["defense_modifier", "enabled"], e.target.checked)
            }
          />
          Abilita il modificatore di difesa
        </label>
        <div className="ls-grid">
          {input(
            "Difensori richiesti",
            ["defense_modifier", "required_defenders"],
            { type: "number", min: 1 },
          )}
        </div>
        <div className="ls-subheading">
          <h3>Fasce difensive</h3>
          <button
            type="button"
            className="ls-text-button"
            onClick={() =>
              update(
                ["defense_modifier", "tiers"],
                [
                  ...profile.defense_modifier.tiers,
                  { minimum_average: 7.5, bonus: 4 },
                ],
              )
            }
          >
            Aggiungi fascia
          </button>
        </div>
        {profile.defense_modifier.tiers.map((tier, index) => (
          <div className="ls-tier" key={index}>
            <label>
              Media minima
              <input
                type="number"
                step="0.1"
                value={tier.minimum_average}
                onChange={(e) => {
                  const tiers = clone(profile.defense_modifier.tiers);
                  tiers[index].minimum_average = number(e.target.value);
                  update(["defense_modifier", "tiers"], tiers);
                }}
              />
            </label>
            <label>
              Bonus
              <input
                type="number"
                step="0.1"
                min="0"
                value={tier.bonus}
                onChange={(e) => {
                  const tiers = clone(profile.defense_modifier.tiers);
                  tiers[index].bonus = number(e.target.value);
                  update(["defense_modifier", "tiers"], tiers);
                }}
              />
            </label>
            <button
              type="button"
              className="ls-remove"
              disabled={profile.defense_modifier.tiers.length === 1}
              onClick={() =>
                update(
                  ["defense_modifier", "tiers"],
                  profile.defense_modifier.tiers.filter(
                    (_, item) => item !== index,
                  ),
                )
              }
            >
              Rimuovi
            </button>
          </div>
        ))}
      </fieldset>
      <fieldset>
        <legend>
          <span>05</span> Giornate e classifica
        </legend>
        <div className="ls-grid">
          {input("Punti vittoria", ["standings", "win_points"], {
            type: "number",
            min: 0,
          })}
          {input("Punti pareggio", ["standings", "draw_points"], {
            type: "number",
            min: 0,
          })}
          {input("Punti sconfitta", ["standings", "loss_points"], {
            type: "number",
            min: 0,
          })}
          {choiceSelect(
            "Parità dopo tutti i criteri",
            ["standings", "exact_tie_policy"],
            exactTiePolicies,
            "Stabilisce come assegnare le posizioni quando tutti i criteri danno ancora parità.",
          )}
        </div>
        <div
          className="ls-choice-card"
          role="group"
          aria-labelledby="tie-breakers-label"
        >
          <p id="tie-breakers-label" className="ls-label">
            Criteri di spareggio, in ordine di priorità
          </p>
          <p className="ls-field-help">
            I punti in classifica hanno sempre priorità. Seleziona uno o più
            criteri successivi e usa i pulsanti per stabilirne l'ordine.
          </p>
          {profile.standings.tie_breakers
            .filter((criterion) => !supportedValues(tieBreakers).has(criterion))
            .map((criterion, index) => (
              <div className="ls-invalid-choice" key={`${criterion}-${index}`}>
                <span>Valore non supportato da correggere</span>
                <button
                  type="button"
                  className="ls-remove"
                  onClick={() => {
                    const next = [...profile.standings.tie_breakers];
                    next.splice(
                      profile.standings.tie_breakers.indexOf(criterion),
                      1,
                    );
                    update(["standings", "tie_breakers"], next);
                  }}
                >
                  Rimuovi
                </button>
              </div>
            ))}
          <div className="ls-choice-list">
            {[
              ...profile.standings.tie_breakers.filter((criterion) =>
                supportedValues(tieBreakers).has(criterion),
              ),
              ...tieBreakers
                .map(({ value }) => value)
                .filter(
                  (criterion) =>
                    !profile.standings.tie_breakers.includes(criterion),
                ),
            ].map((criterion) => {
              const choice = tieBreakers.find(
                ({ value }) => value === criterion,
              );
              const index = profile.standings.tie_breakers.indexOf(criterion);
              const selected = index !== -1;
              return (
                <div className="ls-priority-choice" key={criterion}>
                  <label className="ls-check" title={choice.help}>
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={(event) =>
                        update(
                          ["standings", "tie_breakers"],
                          event.target.checked
                            ? [...profile.standings.tie_breakers, criterion]
                            : profile.standings.tie_breakers.filter(
                                (item) => item !== criterion,
                              ),
                        )
                      }
                    />
                    {choice.label}
                  </label>
                  <span className="ls-field-help">{choice.help}</span>
                  {selected && (
                    <span className="ls-order-actions">
                      <button
                        type="button"
                        title="Sposta il criterio prima"
                        aria-label={`Sposta prima ${choice.label}`}
                        disabled={index === 0}
                        onClick={() => {
                          const next = [...profile.standings.tie_breakers];
                          [next[index - 1], next[index]] = [
                            next[index],
                            next[index - 1],
                          ];
                          update(["standings", "tie_breakers"], next);
                        }}
                      >
                        Su
                      </button>
                      <button
                        type="button"
                        title="Sposta il criterio dopo"
                        aria-label={`Sposta dopo ${choice.label}`}
                        disabled={
                          index === profile.standings.tie_breakers.length - 1
                        }
                        onClick={() => {
                          const next = [...profile.standings.tie_breakers];
                          [next[index], next[index + 1]] = [
                            next[index + 1],
                            next[index],
                          ];
                          update(["standings", "tie_breakers"], next);
                        }}
                      >
                        Giù
                      </button>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div className="ls-grid">
          {choiceSelect(
            "Formazione incompleta",
            ["incomplete_lineup", "policy"],
            incompleteLineupPolicies,
            "Definisce il trattamento di una formazione che non può schierare undici calciatori.",
          )}
          {input(
            profile.incomplete_lineup.policy === "zero_score"
              ? "Punteggio della formazione incompleta (fisso a 0)"
              : "Punteggio della formazione incompleta (non usato)",
            ["incomplete_lineup", "score"],
            {
              type: "number",
              min: 0,
              step: "0.1",
              disabled: true,
              title:
                profile.incomplete_lineup.policy === "zero_score"
                  ? "Con il punteggio zero questo valore deve restare 0."
                  : "Questa politica non usa un punteggio configurabile.",
            },
          )}
        </div>
      </fieldset>
      <fieldset>
        <legend>
          <span>06</span> Asta
        </legend>
        <div className="ls-grid">
          {input("Offerta minima", ["auction", "minimum_bid"], {
            type: "number",
            min: 1,
          })}
          {input("Rilancio minimo", ["auction", "bid_increment"], {
            type: "number",
            min: 1,
          })}
          {input(
            "Crediti riservati per posto libero",
            ["auction", "reserve_credits_per_open_slot"],
            { type: "number", min: 0 },
          )}
          {choiceSelect(
            "Chiamata dei calciatori",
            ["auction", "nomination_policy"],
            nominationPolicies,
            "Stabilisce chi nomina il prossimo calciatore durante l'asta.",
          )}
          {roles.map((role) =>
            input(
              `Budget ${roleBudgetLabels[role]} (%)`,
              ["auction", "role_budget_percentages", role],
              { type: "number", min: 0, step: "0.5", key: role },
            ),
          )}
          {input(
            "Flessibilità target ruolo (%)",
            ["auction", "role_budget_flexibility_percent"],
            { type: "number", min: 0, step: "0.5" },
          )}
          <p className="ls-field-help">
            Totale budget ruoli: {roles.reduce(
              (sum, role) =>
                sum + profile.auction.role_budget_percentages[role],
              0,
            )}% (deve essere 100%).
          </p>
        </div>
      </fieldset>
      <footer className="ls-actions">
        {changePolicy.dirty && (
          <aside className="ls-change-warning" role="status">
            <strong>Modifiche non applicate</strong>
            <span>{changePolicy.fields.join(", ")}</span>
            <small>
              Azione consigliata: {changePolicy.action === "regenerate_dataset"
                ? "salva e rigenera dati"
                : changePolicy.action === "rerun_simulation"
                  ? "salva e riesegui simulazione"
                  : "salva modifiche"}.
            </small>
          </aside>
        )}
        <p>
          {sourcesReady
            ? "Le fonti necessarie sono presenti. Il calendario della lega è facoltativo."
            : "Carica o ripristina le fonti necessarie prima di generare i dati."}
        </p>
        <button type="submit" disabled={busy}>
          {busy ? "Salvataggio..." : "Salva profilo"}
        </button>
        <button
          type="button"
          className="ls-generate"
          disabled={busy || !sourcesReady}
          onClick={() => save(true)}
        >
          {busy ? "Elaborazione..." : "Salva e genera"}
        </button>
      </footer>
    </form>
  );
}

export default LeagueSettings;
