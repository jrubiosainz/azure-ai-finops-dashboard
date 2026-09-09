/**
 * Board components.
 *
 * The quotation cells flip character by character the way a split-flap board settles,
 * so a refresh or a change of registration is legible as movement rather than as a
 * silent substitution. Everything else on the board is still: motion is reserved for
 * figures actually changing.
 */

import { useEffect, useRef, useState } from 'react';
import { CONFIDENCE } from './format.js';

/* ------------------------------------------------------------------ *
 * Split-flap value
 * ------------------------------------------------------------------ */

export function Flap({ value }) {
  const chars = String(value).split('');
  const previous = useRef(chars);
  const [turning, setTurning] = useState(() => chars.map(() => false));

  useEffect(() => {
    const before = previous.current;
    const changed = chars.map((c, i) => before[i] !== c);
    previous.current = chars;
    if (!changed.some(Boolean)) return undefined;

    setTurning(changed);
    const t = setTimeout(() => setTurning(chars.map(() => false)), 520);
    return () => clearTimeout(t);
    // The rendered string is the only dependency that matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [String(value)]);

  return (
    <span aria-label={String(value)}>
      {chars.map((c, i) => (
        <span
          key={`${i}-${c}`}
          aria-hidden="true"
          className={`flap${turning[i] ? ' flap--turning' : ''}`}
          style={turning[i] ? { animationDelay: `${i * 34}ms` } : undefined}
        >
          {c === ' ' ? '\u00A0' : c}
        </span>
      ))}
    </span>
  );
}

export function Quote({ tab, value, unit, note, muted = false }) {
  return (
    <div className={`quote${muted ? ' quote--muted' : ''}`}>
      <span className="quote__tab">{tab}</span>
      <div className="quote__value">
        <Flap value={value} />
        {unit ? <span className="quote__unit">{unit}</span> : null}
      </div>
      {note ? <p className="quote__note">{note}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Provenance mark
 * ------------------------------------------------------------------ */

export function Mark({ level }) {
  const meta = CONFIDENCE[level] ?? CONFIDENCE.none;
  return (
    <span className={`mark mark--${level ?? 'none'}`} title={meta.hint}>
      {meta.label}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Ledger table
 * ------------------------------------------------------------------ */

export function Ledger({ title, note, columns, rows, sort, onSort, empty }) {
  return (
    <section className="ledger">
      <div className="ledger__head">
        <h2 className="ledger__title">{title}</h2>
        {note ? <p className="ledger__note">{note}</p> : null}
      </div>

      {rows.length === 0 ? (
        <p className="empty">{empty ?? 'Ninguna fila cotiza con los registros activos.'}</p>
      ) : (
        <div className="ledger__scroll">
          <table>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={
                      sort.key === c.key
                        ? sort.dir === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                    }
                    onClick={() => onSort(c.key)}
                    title={c.hint ?? `Ordenar por ${c.label}`}
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.__key}>
                  {columns.map((c) => (
                    <td key={c.key}>{c.render(r)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
