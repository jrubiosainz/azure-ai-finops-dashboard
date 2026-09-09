/**
 * The tape: daily spend and daily requests along one continuous strip under the board.
 *
 * This is the trend chart, not a decorative sparkline — it carries its own scale, its
 * own dates and a readable cursor, because "when did this start costing more" is one of
 * the two questions a cost review always asks.
 */

import { useState } from 'react';
import { money, count, shortDate } from './format.js';

const H = 132;
const PAD_TOP = 10;
const PAD_BOTTOM = 20;

export default function Tape({ timeline, currency }) {
  const [cursor, setCursor] = useState(null);

  if (!timeline?.length) {
    return null;
  }

  const maxCost = Math.max(...timeline.map((d) => d.cost), 0.0001);
  const maxCalls = Math.max(...timeline.map((d) => d.calls), 1);
  const plotH = H - PAD_TOP - PAD_BOTTOM;
  const n = timeline.length;
  const slot = 100 / n;

  const linePoints = timeline
    .map((d, i) => {
      const x = slot * i + slot / 2;
      const y = PAD_TOP + plotH - (d.calls / maxCalls) * plotH;
      return `${x.toFixed(3)},${y.toFixed(2)}`;
    })
    .join(' ');

  const active = cursor == null ? null : timeline[cursor];

  return (
    <div className="tape">
      <div className="tape__head">
        <span className="tape__title">Cinta diaria · Suscripción · {n} días</span>
        <span className="tape__legend">
          <span>
            <i style={{ background: '#c2381f' }} />
            Gasto total
          </span>
          <span>
            <i style={{ background: '#b0842e' }} />
            Gasto IA
          </span>
          <span>
            <i style={{ background: '#2f9179' }} />
            Llamadas
          </span>
        </span>
      </div>

      <svg
        className="tape__plot"
        viewBox={`0 0 100 ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Gasto diario durante ${n} días. Máximo ${money(maxCost, currency)} ${currency}.`}
        onMouseLeave={() => setCursor(null)}
      >
        {timeline.map((d, i) => {
          const x = slot * i;
          const h = (d.cost / maxCost) * plotH;
          const aiH = (d.aiCost / maxCost) * plotH;
          return (
            <g key={d.date} className="tape__bar" onMouseEnter={() => setCursor(i)}>
              <rect x={x} y={0} width={slot} height={H} fill="transparent" />
              <rect
                x={x + slot * 0.14}
                y={PAD_TOP + plotH - h}
                width={slot * 0.72}
                height={Math.max(h, 0.6)}
                fill={cursor === i ? '#e2543a' : '#c2381f'}
              />
              <rect
                x={x + slot * 0.14}
                y={PAD_TOP + plotH - aiH}
                width={slot * 0.72}
                height={Math.max(aiH, 0)}
                fill="#b0842e"
              />
            </g>
          );
        })}

        <line
          x1="0"
          x2="100"
          y1={PAD_TOP + plotH}
          y2={PAD_TOP + plotH}
          stroke="#3a424a"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />

        <polyline
          points={linePoints}
          fill="none"
          stroke="#2f9179"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
        />

        {active ? (
          <line
            x1={slot * cursor + slot / 2}
            x2={slot * cursor + slot / 2}
            y1={PAD_TOP - 6}
            y2={PAD_TOP + plotH}
            stroke="#b0842e"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
            strokeDasharray="3 3"
          />
        ) : null}
      </svg>

      <p className="tape__cursor">
        {active ? (
          <>
            <b>{shortDate(active.date)}</b> · total{' '}
            <b>
              {money(active.cost, currency)} {currency}
            </b>{' '}
            · IA{' '}
            <b>
              {money(active.aiCost, currency)} {currency}
            </b>{' '}
            · <b>{count(active.calls)}</b> llamadas
          </>
        ) : (
          <>
            {shortDate(timeline[0].date)} — {shortDate(timeline[n - 1].date)} · máximo diario{' '}
            {money(maxCost, currency)} {currency} · pasa el cursor por la cinta para leer un día
          </>
        )}
      </p>
    </div>
  );
}
