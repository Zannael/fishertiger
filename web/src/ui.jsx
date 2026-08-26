import { useEffect, useRef, useState } from "react";

/**
 * Shared presentational primitives.
 *
 * Everything here is markup and class names only: no dataset knowledge, no
 * auction rules. Views compose these so that a role chip, a row or a sheet
 * behaves identically wherever it appears.
 */

export const ROLE_LABELS = {
  P: "Portieri",
  D: "Difensori",
  C: "Centrocampisti",
  A: "Attaccanti",
};

export const formatTier = (tier) =>
  tier ? tier.replaceAll("_", " ") : "NON CLASSIFICATO";

export const availabilityTone = (status) =>
  ({ TITOLARE: "good", BALLOTTAGGIO: "caution", RISERVA: "muted" })[status] ||
  "muted";

/** Stroke icons, sized by the surrounding CSS and coloured by currentColor. */
const paths = {
  home: "M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  gavel: "m13.5 4.5 6 6M16.5 1.5l6 6M15 9 6 18M3 21h9M9.5 6.5l8 8",
  shield: "M12 3.5 5 6v5.5c0 4.3 2.9 7.6 7 9 4.1-1.4 7-4.7 7-9V6z",
  sliders: "M4 7h10M18 7h2M4 17h4M12 17h8M14 4.5v5M8 14.5v5",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-3.5-3.5",
  close: "M6 6l12 12M18 6 6 18",
  back: "M15 19 8 12l7-7",
  forward: "M9 5l7 7-7 7",
};

export function Icon({ name, ...rest }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={paths[name]} />
    </svg>
  );
}

export function RoleChip({ role, large = false }) {
  return (
    <i
      className={`role-chip role-${role}${large ? " role-chip--lg" : ""}`}
      aria-hidden="true"
    >
      {role}
    </i>
  );
}

export function Segmented({ options, value, onChange, label, roleColors }) {
  return (
    <div
      className={`segmented${roleColors ? " role-filter" : ""}`}
      role="group"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          data-role={roleColors ? option.value : undefined}
          className={option.value === value ? "is-active" : ""}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Meter({ label, value, max = 10, color }) {
  return (
    <span className="meter">
      {label}
      <span className="meter-track">
        <i
          style={{
            "--pct": `${Math.max(0, Math.min(1, value / max)) * 100}%`,
            "--meter-color": color,
          }}
        />
      </span>
    </span>
  );
}

/**
 * A dialog that rises from the bottom edge on phones and centres itself on
 * wider screens. Focus handling, Esc and page inertness come from <dialog>.
 */
export function Sheet({ open, onClose, title, children, footer, wide, flush }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`sheet${wide ? " sheet--wide" : ""}`}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="sheet-inner">
        <div>
          <div className="sheet-grip" />
          <div className="sheet-head">
            <h2>{title}</h2>
            <button
              type="button"
              className="icon-btn"
              onClick={onClose}
              aria-label="Chiudi"
            >
              <Icon name="close" />
            </button>
          </div>
        </div>
        <div className={`sheet-body${flush ? " sheet-body--flush" : ""}`}>
          {children}
        </div>
        {footer ? <div className="sheet-foot">{footer}</div> : null}
      </div>
    </dialog>
  );
}

export function Empty({ title, children }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children ? <span>{children}</span> : null}
    </div>
  );
}

export function Disclosure({ summary, badge, children, defaultOpen = false }) {
  return (
    <details className="disclosure" open={defaultOpen}>
      <summary>
        {summary}
        {badge ? <span className="summary-badge">{badge}</span> : null}
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

/** One player, rendered the same way in every list in the application. */
export function PlayerRow({
  player,
  onClick,
  selected,
  value,
  valueLabel,
  rank,
  className = "",
}) {
  const tone = availabilityTone(player.disponibilita?.status);
  return (
    <button
      type="button"
      className={`row ${className}${selected ? " is-selected" : ""}`.trim()}
      onClick={onClick}
    >
      {rank !== undefined ? <b className="row-rank">{rank}</b> : null}
      <RoleChip role={player.ruolo} />
      <span className="row-main">
        <span className="row-title">
          <i className={`avail avail--${tone}`} aria-hidden="true" />
          {player.nome}
        </span>
        <span className="row-sub">
          {player.squadra} · {formatTier(player.guida_asta_fascia)}
        </span>
      </span>
      {value !== undefined ? (
        <span className="player-metric">
          <b>{value}</b>
          {valueLabel ? <small>{valueLabel}</small> : null}
        </span>
      ) : null}
    </button>
  );
}

/** Matches a CSS media query in React state, so layout-dependent components
 *  (detail panel versus bottom sheet) can render only the variant in use. */
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}
