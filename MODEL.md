# Model Assumptions

The application is intentionally a Classic Fantacalcio advisor for Serie A.
The Serie A source calendar is validated as 20 teams, 38 matchdays and 380
matches. The fantasy league may select a shorter configured interval within
that season.

## Player projections

- Historical observations are weighted newest to oldest: 60%, 30%, 10%.
- A player marked `TITOLARE`, `BALLOTTAGGIO`, or `RISERVA` has a current
  availability prior of 85%, 55%, or 15%. When historical availability exists,
  the final probability is 65% current prior and 35% history.
- Event rates are normalized to a documented 75-minute rated appearance.
- Primary penalty takers receive a 0.12 expected-goal-per-90 uplift.
- European competitions apply a rotation discount to outfield availability.
- Fixture projections vary by opponent strength and home/away status while
  preserving the player-level seasonal mean.

## Auction values

- The source FVM is preserved as `fvm_original`.
- The UI allocates configured role budgets using FVM as a relative weight.
- The default role split is P 7%, D 18%, C 25%, A 50%, with a 5% soft target
  flexibility. These are editable profile rules.
- Advice values the best fixture-aware lineup and missing-vote coverage rather
  than summing the projections of every player in the roster.
- Goalkeepers from the same club form one capped coverage unit; goalkeepers
  from different clubs can add fallback coverage and fixture rotation value.
  Same-club probability follows explicit `PRIMO`, `SECONDO`, `TERZO`, and
  contested hierarchy groups before any unknown goalkeeper.
- Outfield coverage uses configured bench roles, substitution mode, and the
  global substitution cap. Projection deviation contributes only through a
  small probability-weighted upside term, so a zero-vote player has zero value.
- Only an explicit `confirmed_inactive` signal makes a player ineligible.
  `RISERVA`, `NON_CLASSIFICATO`, low probability, and missing editorial tiers
  reduce utility or confidence but are not hard exclusions.
- Fantacalcio Online availability is a current, informational runtime overlay. It
  does not set `confirmed_inactive` or modify projections, values, lineup
  utility, simulations, or auction recommendations.

## Simulation

- Monte Carlo uses a reproducible seed and 1,000 iterations by default.
- Bench composition and the maximum number of substitutions come from
  `bench_switch` in the active profile.
- `Basic` and `Strict` replacements preserve the absent starter's role; `None`
  disables replacements. The configured formation remains unchanged.
- Sample rosters are ordered by probability-weighted projected contribution
  over the configured league horizon, with FVM used only as a tie-breaker.

These are model defaults, not assertions about future player performance.
