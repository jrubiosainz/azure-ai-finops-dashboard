/**
 * The attribution cascade.
 *
 * This is the drill-down and the chart at once. Each rail is one level of the hierarchy,
 * drawn as a proportional band across the full width; picking a segment re-cuts every
 * rail below it. Reading downward is reading the invoice being decomposed — subscription,
 * to group, to resource, to deployment, to meter — which is exactly the argument a FinOps
 * reviewer needs to follow.
 *
 * The bands are a CSS grid whose track sizes carry the proportions, so the geometry
 * interpolates in one layout pass on the compositor's schedule and the labels stay real
 * text in normal flow rather than transformed artwork.
 */

import { useMemo } from 'react';
import { money, count, tokens, pct } from './format.js';

/** Beyond this a band becomes stripes; the tail is pooled into an inert remainder. */
const MAX_SEGMENTS = 14;

/** A segment narrower than this cannot hold even an abbreviated label. */
const LABEL_FLOOR = 0.055;

export const METRICS = {
  cost: { label: 'Coste', unit: null, format: (v, c) => money(v, c), axis: 'cost' },
  calls: { label: 'Llamadas', unit: null, format: (v) => count(v), axis: 'calls' },
  tokens: { label: 'Tokens', unit: null, format: (v) => tokens(v), axis: 'tokens' },
};

/* ------------------------------------------------------------------ *
 * Rail
 * ------------------------------------------------------------------ */

function Rail({ level, rows, selected, metric, currency, onPick, index }) {
  const meta = METRICS[metric];

  const { segments, remainder } = useMemo(() => {
    const scored = rows
      .map((r) => ({ ...r, amount: Math.max(0, Number(r[meta.axis]) || 0) }))
      .sort((a, b) => b.amount - a.amount);

    const head = scored.slice(0, MAX_SEGMENTS);
    const tail = scored.slice(MAX_SEGMENTS);
    return {
      segments: head.filter((s) => s.amount > 0),
      remainder: tail.reduce((s, r) => s + r.amount, 0),
    };
  }, [rows, meta.axis]);

  const sum = segments.reduce((s, r) => s + r.amount, 0) + remainder;

  if (!sum) {
    return (
      <div className="rail rail--void">
        <div className="rail__name">{level.label}</div>
        <p className="rail__empty">{level.empty ?? 'Sin importe atribuible en este tramo.'}</p>
      </div>
    );
  }

  // Track sizes are the proportions. A floor keeps a 0.01 % slice clickable.
  const tracks = [
    ...segments.map((s) => `minmax(0.35rem, ${(s.amount / sum).toFixed(5)}fr)`),
    ...(remainder > 0 ? [`minmax(0.35rem, ${(remainder / sum).toFixed(5)}fr)`] : []),
  ].join(' ');

  return (
    <div className="rail" style={{ '--depth': index }}>
      <div className="rail__name">
        {level.label}
        <span className="rail__count">{rows.length}</span>
      </div>

      <div className="rail__band" style={{ gridTemplateColumns: tracks }} role="list">
        {segments.map((s, i) => {
          const share = s.amount / sum;
          const on = selected === s.key;
          return (
            <button
              // Two deployments in different accounts can share a name, so the row key
              // alone is not unique. A duplicate key silently breaks reconciliation and
              // leaves stale segments behind when the axis changes.
              key={`${s.key}::${i}`}
              type="button"
              role="listitem"
              className={`seg${on ? ' seg--on' : ''}${s.ai ? ' seg--ai' : ''}`}
              style={{ '--share': share }}
              aria-pressed={on}
              title={`${s.label} · ${meta.format(s.amount, currency)} · ${pct(share)}`}
              onClick={() => onPick(level.id, on ? null : s.key)}
            >
              <span className="seg__body">
                {share >= LABEL_FLOOR ? (
                  <>
                    <span className="seg__label">{s.label}</span>
                    <span className="seg__value">{meta.format(s.amount, currency)}</span>
                  </>
                ) : null}
              </span>
            </button>
          );
        })}

        {remainder > 0 ? (
          <div className="seg seg--rest" role="listitem" title={`Cola: ${meta.format(remainder, currency)}`}>
            <span className="seg__body">
              {remainder / sum >= LABEL_FLOOR ? <span className="seg__label">cola</span> : null}
            </span>
          </div>
        ) : null}
      </div>

      <div className="rail__foot">
        {selected ? (
          <button type="button" className="rail__clear" onClick={() => onPick(level.id, null)}>
            {rows.find((r) => r.key === selected)?.label ?? selected} ×
          </button>
        ) : (
          <span className="rail__total">{meta.format(sum, currency)}</span>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Cascade
 * ------------------------------------------------------------------ */

export default function Cascade({ levels, path, metric, currency, onPick, onReset }) {
  const trail = levels.filter((l) => path[l.id]);

  return (
    <section className="cascade" aria-label="Cascada de atribución">
      <div className="cascade__head">
        <h2 className="cascade__title">Cascada de atribución</h2>

        <nav className="crumbs" aria-label="Ruta de desglose">
          <button
            type="button"
            className="crumb crumb--root"
            aria-current={trail.length === 0 ? 'true' : undefined}
            onClick={onReset}
          >
            Suscripción
          </button>
          {trail.map((l, i) => (
            <button
              key={l.id}
              type="button"
              className="crumb"
              aria-current={i === trail.length - 1 ? 'true' : undefined}
              onClick={() => onPick(l.id, null)}
            >
              <span className="crumb__level">{l.label}</span>
              {l.rows.find((r) => r.key === path[l.id])?.label ?? path[l.id]}
            </button>
          ))}
        </nav>
      </div>

      <div className="rails">
        {levels.map((l, i) => (
          <Rail
            key={l.id}
            index={i}
            level={l}
            rows={l.rows}
            total={l.total}
            selected={path[l.id] ?? null}
            metric={metric}
            currency={currency}
            onPick={onPick}
          />
        ))}
      </div>
    </section>
  );
}
