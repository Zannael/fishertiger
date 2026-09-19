import json
from pathlib import Path

import pytest

from advisor.fco_intelligence import (
    FcoIntelligenceError,
    _audit_performance,
    _benchmark_cohort,
    _check_forecast,
    _check_performance,
    _price_cohort,
    _require_unique_canonical,
    _store_market,
    _store_performance,
    _unresolved_summary,
    form_analytics,
    _write,
    parse_cumulative,
    parse_forecast,
    parse_lineups,
    parse_ownership,
    parse_performance,
    parse_prices,
)

SEASON = "2026/27"


def forecast_html(*, season="2026/2027", date="19/09/2026", current="6.60", potential="7.50", titularity="7.00", duplicate=False):
    entry = f"""<div data-entry><div data-prop-name='player'><div data-prop-name='id'>5678</div><div data-prop-name='firstName'>Djed</div><div data-prop-name='lastName'>SPENCE</div><div data-prop-name='kapitals'>17</div><div data-prop-name='overall'>{potential}</div><div data-prop-name='pot'>{current}</div><div data-prop-name='lineupRating'>{titularity}</div></div><div data-prop-name='realteam'><div data-prop-name='name'>Inter</div></div></div>"""
    return f"""<h1>Quotazioni Fantacalcio Serie A {season}</h1><p class='fco-hero__sub'>Lista aggiornata al {date}.</p><div class='fco-nota'>FantaIndex Rating: prestazioni attese. FantaIndex Titolarità: probabilità di scendere in campo sul torneo.</div><div id='quotations-dataset'>{entry}{entry if duplicate else ''}</div>"""


def test_forecast_semantics_ranges_season_and_structure(tmp_path):
    parsed = parse_forecast(forecast_html(), SEASON)
    row = parsed["rows"][0]
    assert parsed["source_date"] == "2026-09-19" and row["quotation"] == 17
    assert (row["fantaindex_current"], row["fantaindex_potential"], row["season_availability_pct"]) == (6.6, 7.5, 70)
    for html, message in ((forecast_html(season="2025/2026"), "season"), (forecast_html(date="99/09/2026"), "date"), (forecast_html(current="10.1"), "0-10"), (forecast_html(titularity="10.1"), "0-100"), (forecast_html(duplicate=True), "Duplicate"), (forecast_html().replace("prestazioni attese", "dato"), "semantics"), (forecast_html().replace("data-prop-name='pot'", "data-prop-name='changed'"), "structure")):
        with pytest.raises(FcoIntelligenceError, match=message):
            parse_forecast(html, SEASON)
    class Profile:
        profile_id = "test"
        class season:
            season = SEASON
    snapshot = _check_forecast(tmp_path, Profile(), lambda _: forecast_html(), [], "2026-09-19T10:00:00+00:00")
    assert snapshot["resolved"] == 0 and snapshot["unresolved_classifications"]["team_not_in_active_listone"] == 1


def vote_table(caption, name, state="", votes=("6,5", "s.v.", "–"), bonus=""):
    return f"""
    <table><caption>{caption}</caption><thead><tr><th>Player</th><th>FC</th><th>ROM</th><th>TOR</th></tr></thead>
    <tbody><tr><th><span class='prb-nome'>{name}<small>A</small></span><span class='prb-tabellino'>
    {state}{bonus}</span></th>{''.join(f'<td>{vote}</td>' for vote in votes)}</tr></tbody></table>"""


@pytest.fixture
def performance_html():
    panes = []
    for index in range(10):
        status = "Terminata"
        header = f"""<header class='prb-incontro'><a class='prb-incontro__nome'>Home{index}</a>
        <p class='prb-incontro__punteggio'>2:1</p><p class='prb-incontro__stato'>{status}</p>
        <p class='prb-incontro__data'>{index + 1:02}/09/2026 20:45</p><a class='prb-incontro__nome'>Away{index}</a></header>"""
        home = vote_table("Scesi in campo: voto di ogni redazione", f"Starter{index}", "<span title='Sostituito dopo 61 minuti'></span>", ("6,5", "6", "6"), "<span title='1 Goal Segnato su Azione'></span><span title='Ammonizione'></span>")
        home += vote_table("In panchina: voto di ogni redazione", f"Sub{index}", "<span title='Entrato dalla panchina — 29 minuti giocati'></span>", ("s.v.", "6", "6"), "<span title='1 Assist Intenzionale su Azione'></span>")
        away = vote_table("Scesi in campo: voto di ogni redazione", f"Other{index}", votes=("6", "6", "6"), bonus="<span title='1 Goal Subito'></span><span title='Espulsione'></span>")
        away += vote_table("In panchina: voto di ogni redazione", f"Unused{index}", "<span title='Non è mai entrato in campo'></span>")
        panes.append(f"<div class='tab-pane'>{header}<section class='prb-squadra'><h2 class='prb-squadra__nome'>Home{index}</h2>{home}</section><section class='prb-squadra'><h2 class='prb-squadra__nome'>Away{index}</h2>{away}</section></div>")
    return "<html><head><title>Voti Fantacalcio Serie A 2026/2027 - 3ª Giornata</title></head><body><h1>Voti della 3ª giornata</h1>" + "".join(panes) + "</body></html>"


def test_performance_votes_context_events_and_provisional(performance_html):
    parsed = parse_performance(performance_html, SEASON, 3)
    starter, substitute, unused = parsed["records"][0], parsed["records"][1], parsed["records"][3]
    assert len(parsed["fixtures"]) == 10 and parsed["state"] == "final"
    assert starter["started"] and starter["substitution_minute"] == 61 and starter["goals"] == 1 and starter["yellow_cards"] == 1
    assert starter["vote_fc"] == {"state": "numeric", "value": 6.5}
    assert substitute["entered_from_bench"] and substitute["entry_minute"] is None and substitute["minutes_played"] == 29 and substitute["assists"] == 1
    assert substitute["vote_fc"]["state"] == "sv" and unused["did_not_enter"] and unused["vote_torino"]["state"] == "unpublished"
    assert starter["penalties_scored"] is None
    unfinished = performance_html.replace("Terminata", "Non iniziata", 1)
    assert parse_performance(unfinished, SEASON, 3)["state"] == "provisional"
    empty_unstarted = unfinished.replace("<section class='prb-squadra'>", "<section class='removed'>", 2)
    assert len(parse_performance(empty_unstarted, SEASON, 3)["fixtures"]) == 10
    postponed = performance_html.replace("Terminata", "Rinviata", 1)
    assert parse_performance(postponed, SEASON, 3)["state"] == "provisional"
    typo = parse_performance(performance_html.replace("1 Assist Intenzionale", "2 Assit da Fermo", 1), SEASON, 3)
    assert typo["records"][1]["assists"] == 2


def ownership_html(*, cohort="", pct="17,2%", delta="-2,9"):
    dataset = {"@type": "Dataset", "name": "I giocatori più comprati all'asta di fantacalcio 2026/2027", "dateModified": "2026-09-18", "measurementTechnique": "contando solo le squadre con più di 10 giocatori"}
    return f"""<script type='application/ld+json'>{json.dumps(dataset)}</script><h1>Asta fantacalcio 2026/2027: i giocatori più comprati</h1><p>Dati rifatti ogni notte. Da 30 squadre in su.</p>
    <form><select name='ruoli'><option value='fcit' selected>FCIT</option></select>
    <select name='leghe'><option value='{cohort}' selected>Cohort</option></select></form>
    <p class='fco-tagli__intro'>L'elenco del giorno, aggiornato al 18/09/2026: 1 calciatori quotati</p>
    <table id='piu_comprati'><thead><tr>{''.join(f'<th>{h}</th>' for h in ['Ruolo','Squadra','Nome','Kap.','Comprato da','Prezzo 350','Prezzo 500','Titolare','7 gg'])}</tr></thead>
    <tbody><tr><td>A</td><td>Roma</td><td>MALEN Donyell</td><td>62</td><td>{pct}</td><td>71</td><td>100</td><td></td><td>{delta}</td></tr></tbody></table>"""


@pytest.mark.parametrize("cohort,raw", [("overall", ""), ("lte9", "piccole"), ("gte10", "grandi")])
def test_ownership_contract_and_cohorts(cohort, raw):
    row = parse_ownership(ownership_html(cohort=raw), SEASON, cohort)["rows"][0]
    assert row["ownership_pct"] == 17.2 and row["ownership_delta_7d"] == -2.9
    assert parse_ownership(ownership_html(cohort=raw, pct="", delta="+1,5"), SEASON, cohort)["rows"][0]["ownership_pct"] is None
    with pytest.raises(FcoIntelligenceError, match="Malformed percentage"):
        parse_ownership(ownership_html(cohort=raw, pct="maybe"), SEASON, cohort)


def price_html(badge="", prices=("71.62", "72", "95", "99")):
    dataset = {"@type": "Dataset", "name": "Prezzi medi d'asta del fantacalcio 2025/2026", "dateModified": "2026-09-18", "measurementTechnique": "soglia minima di 3 aste per calciatore", "size": {"value": 1}}
    name = f"<span class='text-bold'>MALEN</span><span class='text-muted'>Donyell</span>{badge}"
    headers = ['Ruolo','Squadra','Nome','Kap.','8 sq. / 350','10 sq. / 350','8 sq. / 500','10 sq. / 500','M.V.','Pres.']
    return f"""<script type='application/ld+json'>{json.dumps(dataset)}</script><p class='fco-occhiello'>Asta 2026/2027</p><table id='players_list'><thead><tr>{''.join(f'<th>{h}</th>' for h in headers)}</tr></thead><tbody><tr><td>A</td><td>Roma</td><td>{name}</td><td>62</td>{''.join(f'<td>{x}</td>' for x in prices)}<td>6,2</td><td>30</td></tr></tbody></table>"""


def test_prices_current_fallback_new_blank_and_four_cohorts():
    current = parse_prices(price_html(), SEASON)["rows"][0]
    assert [current[field]["value"] for field in ("price_8_350", "price_10_350", "price_8_500", "price_10_500")] == [71.62, 72.0, 95.0, 99.0]
    assert current["price_8_350"]["current_season"]
    old = parse_prices(price_html("<span class='fco-etichetta'>2025/2026</span>"), SEASON)["rows"][0]
    assert old["price_8_350"]["fallback_previous_season"] and old["price_8_350"]["price_season"] == "2025/26"
    new = parse_prices(price_html("<span class='fco-etichetta'>Nuovo</span>", ("", "", "", "")), SEASON)["rows"][0]
    assert new["new_player"] and new["price_10_500"]["unavailable"]
    with pytest.raises(FcoIntelligenceError, match="three-auction"):
        parse_prices(price_html().replace("soglia minima di 3 aste", "soglia minima di 10 aste"), SEASON)
    with pytest.raises(FcoIntelligenceError, match="season"):
        parse_prices(price_html("<span class='fco-etichetta'>2025/2026</span>").replace("Asta 2026/2027", "Asta 2025/2026"), SEASON)


def lineup_table(caption, name, values=("60%", "90%", "–", "90%", "69%"), official=False):
    headers = ["Titolare", "Fc", "Gaz", "SOS", "Sky", "Media*", "Uff."]
    return f"<table><caption>{caption}</caption><thead><tr>{''.join(f'<th>{x}</th>' for x in headers)}</tr></thead><tbody><tr><th><span class='prb-nome'>{name}<small>A</small></span></th>{''.join(f'<td>{x}</td>' for x in values)}<td>{'<span>confermato</span>' if official else ''}</td></tr></tbody></table>"


@pytest.fixture
def lineups_html():
    panes = []
    for index in range(10):
        header = f"<header class='prb-incontro'><a class='prb-incontro__nome'>Home{index}</a><p class='prb-incontro__punteggio'></p><p class='prb-incontro__stato'>Non iniziata</p><p class='prb-incontro__data'>2{index}/09/2026 20:45</p><a class='prb-incontro__nome'>Away{index}</a></header>"
        sections = []
        for side in ("Home", "Away"):
            team = f"{side}{index}"
            tables = lineup_table("Probabili titolari: percentuale di schierabilita' per redazione", f"Starter{side}{index}", official=index == 0 and side == "Home")
            tables += lineup_table("Probabile panchina: percentuale di schierabilita' per redazione", f"Bench{side}{index}", ("10%", "20%", "30%", "40%", "21%"))
            unavailable = f"<div class='prb-fuori'><p class='prb-fuori__titolo'>Indisponibili</p><ul><li class='prb-fuori__riga'><span class='prb-nome'>Out{side}{index}<small>A</small></span></li></ul></div>"
            sections.append(f"<section class='prb-squadra'><h2 class='prb-squadra__nome'>{team}</h2>{tables}{unavailable}</section>")
        panes.append(f"<div class='tab-pane'>{header}{''.join(sections)}</div>")
    dataset = {"@type": "Dataset", "name": "Probabili formazioni 5ª giornata di Serie A 2026/2027", "dateModified": "2026-09-18T18:00:00+02:00"}
    return f"<script type='application/ld+json'>{json.dumps(dataset)}</script><p>Ultima rilevazione: 18 settembre 2026 alle 18:00. Per questa giornata hanno pubblicato <b>4 redazioni su 4</b> per un totale di <b>60 calciatori</b> valutati.</p>{''.join(panes)}"


def test_lineups_sources_weighted_sections_and_official(lineups_html):
    parsed = parse_lineups(lineups_html, SEASON, 5)
    starter, bench, unavailable = parsed["rows"][:3]
    assert len(parsed["fixtures"]) == 10 and len(parsed["rows"]) == 60
    assert starter["section"] == "probable_starter" and starter["weighted_pct"] == 69 and starter["sos_pct"] is None and starter["source_count"] == 3 and starter["official_confirmed"]
    assert starter["fixture_state"] == "upcoming" and starter["fixture_status"] == "Non iniziata"
    assert bench["section"] == "probable_bench" and unavailable["section"] == "unavailable" and unavailable["weighted_pct"] is None
    fewer = lineups_html.replace("4 redazioni su 4", "3 redazioni su 4", 1)
    assert parse_lineups(fewer, SEASON, 5)["active_source_count"] == 3
    changed = lineups_html.replace("2026-09-18T18:00:00+02:00", "2026-09-18T19:00:00+02:00")
    assert parse_lineups(changed, SEASON, 5)["observation_at"].endswith("19:00:00+02:00")


def test_lineups_accept_valid_zero_source_matchday():
    panes = []
    for index in range(10):
        header = f"<header class='prb-incontro'><a class='prb-incontro__nome'>Home{index}</a><p class='prb-incontro__stato'>Non iniziata</p><p class='prb-incontro__data'>2{index}/09/2026 20:45</p><a class='prb-incontro__nome'>Away{index}</a></header>"
        teams = "".join(f"<section class='prb-squadra'><h2 class='prb-squadra__nome'>{side}{index}</h2></section>" for side in ("Home", "Away"))
        panes.append(f"<div class='tab-pane'>{header}{teams}</div>")
    dataset = {"@type": "Dataset", "name": "Probabili formazioni 5ª giornata di Serie A 2026/2027", "dateModified": "2026-09-18T08:00:00+02:00"}
    html = f"<script type='application/ld+json'>{json.dumps(dataset)}</script><p>Ultima rilevazione: 18 settembre 2026 alle 08:00. Per questa giornata hanno pubblicato <b>0 redazioni su 4</b> per un totale di <b>0 calciatori</b> valutati.</p>{''.join(panes)}"
    parsed = parse_lineups(html, SEASON, 5)
    assert len(parsed["fixtures"]) == 10 and parsed["rows"] == [] and parsed["source_state"] == "awaiting_sources"


def cumulative_html(assists=2):
    headers = ["RT", "Squadra", "Nome", "Kap.", "PR", "MV5", "FM5", "", "GR+", "GR-", "RG+", "A+", "AF+", "PD+", "P/T", "EG-", "ET-", "RC-"]
    values = ["A", "Roma", "Malen", "62", "", "", "", "", "0", "0", "0", str(assists), "0", "0", "0", "0", "0", "0"]
    return f"<p class='fco-occhiello'>Serie A 2026/2027</p><table><thead><tr>{''.join(f'<th>{x}</th>' for x in headers)}</tr></thead><tbody><tr>{''.join(f'<td>{x}</td>' for x in values)}</tr></tbody></table>"


def test_cumulative_cross_check_discrepancy(tmp_path):
    rows = parse_cumulative(cumulative_html(), SEASON)
    players = [{"Id": 1, "Nome": "Malen", "Squadra": "Roma", "R": "A"}]
    directory = tmp_path / "performance-v1"
    snapshot = {"state": "final", "event_availability": {"assists": True}, "players": [{"fantacalcio_id": 1, "assists": 1}]}
    path = directory / "matchdays" / "01.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(snapshot))
    audit = _audit_performance(directory, rows, players)
    assert audit["discrepancies"] == [{"fantacalcio_id": 1, "canonical_name": "Malen", "canonical_team": "Roma", "metric": "assists", "final_matchday_total": 1, "matchdays": 1, "cumulative": 2}]


def test_cumulative_audit_separates_provisional_sync(tmp_path):
    players = [{"Id": 1, "Nome": "Malen", "Squadra": "Roma", "R": "A"}]
    directory = tmp_path / "performance-v1"
    matchdays = directory / "matchdays"
    matchdays.mkdir(parents=True)
    base = {"event_availability": {"assists": True}, "players": [{"fantacalcio_id": 1, "assists": 1}]}
    (matchdays / "01.json").write_text(json.dumps({**base, "state": "final", "matchday": 1}))
    (matchdays / "02.json").write_text(json.dumps({**base, "state": "provisional", "matchday": 2}))
    audit = _audit_performance(directory, parse_cumulative(cumulative_html(1), SEASON), players)
    assert audit["discrepancies"] == []
    assert audit["pending_sync"][0] == {"fantacalcio_id": 1, "canonical_name": "Malen", "canonical_team": "Roma", "metric": "assists", "final_matchday_total": 1, "provisional_addition": 1, "cumulative": 1, "provisional_matchdays": [2]}
    (matchdays / "02.json").write_text(json.dumps({**base, "state": "final", "matchday": 2}))
    assert len(_audit_performance(directory, parse_cumulative(cumulative_html(1), SEASON), players)["discrepancies"]) == 1
    assert _audit_performance(directory, parse_cumulative(cumulative_html(2), SEASON), players)["discrepancies"] == []


def test_form_analytics_uses_final_rounds_and_numeric_votes_only():
    identity = {"fantacalcio_id": 1, "canonical_name": "Malen", "canonical_team": "Roma", "canonical_role": "A"}
    rows = [
        {**identity, "matchday": 1, "started": True, "entered_from_bench": False, "did_not_enter": False, "minutes_played": 90, "vote_fc": {"state": "numeric", "value": 6}, "goals": 1, "assists": 0, "yellow_cards": 0, "red_cards": 0},
        {**identity, "matchday": 2, "started": False, "entered_from_bench": True, "did_not_enter": False, "minutes_played": 20, "vote_fc": {"state": "sv", "value": None}, "goals": 0, "assists": 1, "yellow_cards": 1, "red_cards": 0},
        {**identity, "matchday": 3, "started": False, "entered_from_bench": False, "did_not_enter": True, "minutes_played": 0, "vote_fc": {"state": "unpublished", "value": None}, "goals": 0, "assists": 0, "yellow_cards": 0, "red_cards": 0},
    ]
    provisional = {**rows[0], "matchday": 4, "vote_fc": {"state": "numeric", "value": 10}, "goals": 5}
    result = form_analytics([{"state": "final", "matchday": 1, "players": rows}, {"state": "provisional", "matchday": 4, "players": [provisional]}])[0]
    assert (result["final_appearances"], result["starts"], result["substitute_appearances"], result["minutes"]) == (2, 1, 1, 110)
    assert result["numeric_fc_votes"] == 1 and result["mean_fc_vote"] == 6 and result["goals"] == 1 and result["assists"] == 1
    assert result["last_3_sample_size"] == 1 and result["last_5_sample_size"] == 1 and result["provisional_matchdays"] == [4]


def test_unresolved_identity_and_final_revision_are_traceable(tmp_path, performance_html):
    class Profile:
        profile_id = "test"
        class season:
            season = SEASON
    parsed = parse_performance(performance_html, SEASON, 3)
    first = _store_performance(tmp_path, Profile(), parsed, 3, "2026-09-18T10:00:00+00:00", [])
    assert first["unresolved"] and first["validation"]["resolved"] == 0
    revised = parse_performance(performance_html.replace("6,5", "7,0", 1), SEASON, 3)
    second = _store_performance(tmp_path, Profile(), revised, 3, "2026-09-18T11:00:00+00:00", [])
    assert len(second["revisions"]) == 1
    assert list((tmp_path / "test/2026-27/performance-v1/revisions/03").glob("*.json"))


def test_daily_market_history_is_immutable_and_not_duplicated(tmp_path):
    first = {"checked_at": "one", "market_source_date": "2026-09-18", "price_source_date": "2026-09-17", "players": []}
    _store_market(tmp_path, first)
    _store_market(tmp_path, {**first, "checked_at": "two"})
    assert len(list((tmp_path / "history").iterdir())) == 1
    second = {**first, "checked_at": "three", "price_source_date": "2026-09-18", "players": [1]}
    _store_market(tmp_path, second)
    assert len(list((tmp_path / "history").iterdir())) == 2
    assert json.loads((tmp_path / "latest.json").read_text())["price_source_date"] == "2026-09-18"


def test_price_cohorts_are_explicit_not_nearest():
    assert _price_cohort(8, 400)[0]["field"] == "price_8_350"
    assert _price_cohort(9, 440)[0]["field"] == "price_10_500"
    assert _price_cohort(8, 750)[0] is None
    assert "750 credits" in _price_cohort(8, 750)[1]
    assert _benchmark_cohort(8)["field"] == "price_8_500"
    assert _benchmark_cohort(10)["field"] == "price_10_500"
    assert _benchmark_cohort(12) is None


@pytest.mark.parametrize("source", ["market snapshot", "performance matchday 4", "lineup probability snapshot", "forecast snapshot"])
def test_duplicate_canonical_identity_fails_closed_with_source_rows(source):
    rows = [{"fantacalcio_id": 1, "provider_name": "One", "provider_team": "Roma"}, {"fantacalcio_id": 1, "provider_name": "Two", "provider_team": "Roma"}]
    with pytest.raises(FcoIntelligenceError, match="One.*Two"):
        _require_unique_canonical(rows, source)


def test_unresolved_classification_summary():
    summary = _unresolved_summary([{"unresolved_classification": "outside_active_listone"}, {"unresolved_classification": "ambiguous"}])
    assert summary == {"outside_active_listone": 1, "fuzzy_requires_confirmation": 0, "ambiguous": 1, "team_not_in_active_listone": 0, "other": 0}


def test_finalized_rounds_are_not_refetched_during_normal_updates(tmp_path, performance_html):
    class Profile:
        profile_id = "test"
        class season:
            season = SEASON
    profile = Profile()
    for matchday in range(1, 4):
        html = performance_html.replace("3ª Giornata", f"{matchday}ª Giornata").replace("3ª giornata", f"{matchday}ª giornata")
        _store_performance(tmp_path, profile, parse_performance(html, SEASON, matchday), matchday, "2026-09-18T10:00:00+00:00", [])
    calls = []
    def fetcher(url):
        calls.append(url)
        return performance_html if "voti/ultima-giornata" in url else cumulative_html()
    result = _check_performance(tmp_path, profile, fetcher, [], "2026-09-18T11:00:00+00:00", False)
    assert result["final_matchdays"] == 3
    assert len(calls) == 2 and not any("voti/1-giornata" in url or "voti/2-giornata" in url or "voti/3-giornata" in url for url in calls)
