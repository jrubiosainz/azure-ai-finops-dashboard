/** Formatting and small shared helpers for the board. */

const nf = (min, max) =>
  new Intl.NumberFormat('es-ES', { minimumFractionDigits: min, maximumFractionDigits: max });

const int0 = nf(0, 0);
const dec2 = nf(2, 2);
const dec4 = nf(4, 4);

/** Money, at a precision that stays honest about very small AI charges. */
export function money(v, currency = 'USD') {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1000) return int0.format(n);
  if (abs >= 1) return dec2.format(n);
  if (abs >= 0.0001) return dec4.format(n);
  return '<0,0001';
}

/** Rates are quoted at six decimals: per-1k-token prices are genuinely that small. */
export function rate(v) {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '—';
  if (n < 0.000001) return '<0,000001';
  return nf(6, 6).format(n);
}

export function count(v) {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return int0.format(Math.round(n));
}

/** Token volumes compress hard; a board cell cannot carry nine digits. */
export function tokens(v) {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '0';
  if (n >= 1e9) return `${dec2.format(n / 1e9)} B`;
  if (n >= 1e6) return `${dec2.format(n / 1e6)} M`;
  if (n >= 1e3) return `${dec2.format(n / 1e3)} k`;
  return int0.format(n);
}

export function pct(v, digits = 1) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${nf(digits, digits).format(n * 100)} %`;
}

/** Spanish plurals, because "1 despliegues" reads as a bug in a document about rigour. */
export function plural(n, one, many) {
  return `${int0.format(n)} ${n === 1 ? one : many}`;
}

export function shortDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
}

export function dateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-ES', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const CONFIDENCE = {
  billed: { label: 'Facturado', hint: 'Cifra directa de Cost Management.' },
  metered: { label: 'Medido', hint: 'Cifra directa de Azure Monitor.' },
  derived: { label: 'Derivado', hint: 'Coste atribuido por cuota de tokens; tarifas calculadas con coste y consumo.' },
  modelled: { label: 'Estimado', hint: 'Reparto por agentes registrados, no una medición por agente.' },
  none: { label: 'Sin datos', hint: 'No hay consumo medido en la ventana.' },
};

export function sortBy(rows, key, dir) {
  const factor = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (typeof av === 'string' || typeof bv === 'string') {
      return String(av ?? '').localeCompare(String(bv ?? ''), 'es') * factor;
    }
    return ((Number(av) || 0) - (Number(bv) || 0)) * factor;
  });
}
