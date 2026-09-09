/**
 * The call tape and its coverage assay.
 *
 * Azure Monitor can say a deployment burned four million tokens. Only an instrumented
 * caller can say which agent asked, in which conversation, how long it waited and whether
 * it succeeded. That evidence lives in Application Insights as OpenTelemetry GenAI spans,
 * and this is where it is read back.
 *
 * The assay above the tape is not decoration. A FinOps reviewer's first question about
 * per-call evidence is "does it cover the whole bill", and here the answer is usually no —
 * so the gap is stated in the same type size as the finding.
 */

import { useMemo, useState } from 'react';
import { count, tokens, pct, money } from './format.js';

const OPERATION_LABEL = {
  chat: 'chat',
  invoke_agent: 'agente',
  execute_tool: 'herramienta',
  embeddings: 'embeddings',
};

/** Latency bars are scaled against this ceiling so one 40 s outlier cannot flatten the rest. */
const LATENCY_CLAMP = 4000;

function Assay({ coverage, currency, attributedCost }) {
  const {
    components, workspaces, workspacesWithData, workspacesWithGenai,
    instrumentedCalls, callsWithUsage, meteredCalls, identities, addresses, maskedAddresses,
  } = coverage;

  const explained = meteredCalls > 0 ? callsWithUsage / meteredCalls : 0;

  return (
    <div className="assay">
      <div className="assay__figures">
        <Figure value={count(instrumentedCalls)} label="registros GenAI" tone={instrumentedCalls ? 'ok' : 'off'} />
        <Figure value={count(callsWithUsage)} label="con tokens por llamada" tone={callsWithUsage ? 'warn' : 'off'} />
        <Figure value={count(identities)} label="identidades de usuario" tone={identities ? 'ok' : 'off'} />
        <Figure value={count(addresses)} label="direcciones IP visibles" tone={addresses ? 'ok' : 'off'} />
      </div>

      <div className="assay__gauge" role="img" aria-label={`${pct(explained, 2)} al comparar registros con tokens y peticiones medidas`}>
        <div className="gauge">
          <div className="gauge__fill" style={{ '--fill': Math.max(explained, 0.004) }} />
          <div className="gauge__mark" />
        </div>
        <p className="assay__read">
          <b>{pct(explained, 2)}</b>: {count(callsWithUsage)} registros con tokens frente a{' '}
          <b>{count(meteredCalls)}</b> peticiones medidas. Una traza no equivale necesariamente a una
          petición; este indicador no mide el porcentaje de factura conciliada.
        </p>
      </div>

      <dl className="assay__grid">
        <div>
          <dt>Componentes de Application Insights</dt>
          <dd>{count(components)} en la suscripción, {count(workspaces)} workspaces</dd>
        </div>
        <div>
          <dt>Workspaces con telemetría en la ventana</dt>
          <dd>{count(workspacesWithData)} con datos · {count(workspacesWithGenai)} con trazas GenAI</dd>
        </div>
        <div>
          <dt>Direcciones enmascaradas por Azure</dt>
          <dd>
            {count(maskedAddresses)} llamadas llegan con <code>0.0.0.0</code>
          </dd>
        </div>
        <div>
          <dt>Coste atribuido a despliegues (no a trazas)</dt>
          <dd>{money(attributedCost, currency)} {currency}</dd>
        </div>
      </dl>
    </div>
  );
}

function Figure({ value, label, tone }) {
  return (
    <div className={`figure figure--${tone}`}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The tape itself
 * ------------------------------------------------------------------ */

function Call({ call, currency, ratePer1k }) {
  const total = call.inputTokens + call.outputTokens;
  const cost = ratePer1k && total ? (total / 1000) * ratePer1k : null;
  const latency = Math.min(call.durationMs, LATENCY_CLAMP) / LATENCY_CLAMP;

  return (
    <li className={`call${call.ok ? '' : ' call--failed'}`}>
      <time className="call__at" dateTime={call.at}>
        {new Date(call.at).toLocaleString('es-ES', {
          day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
        })}
      </time>

      <span className="call__who">
        <b>{call.agentName ?? call.app}</b>
        {call.model ? <em>{call.model}</em> : null}
      </span>

      <span className="call__op">{OPERATION_LABEL[call.operation] ?? call.operation ?? call.tool ?? '—'}</span>

      <span className="call__tok">
        {total > 0 ? (
          <>
            <i className="call__split" style={{ '--in': total ? call.inputTokens / total : 0 }} aria-hidden="true" />
            {tokens(call.inputTokens)} / {tokens(call.outputTokens)}
          </>
        ) : (
          <span className="call__none">sin uso declarado</span>
        )}
      </span>

      <span className="call__lat">
        <i style={{ '--lat': latency }} aria-hidden="true" />
        {call.durationMs > 0 ? `${Math.round(call.durationMs)} ms` : '—'}
      </span>

      <span className="call__cost" title="Estimación con la tarifa media global, no un cargo individual">
        {cost != null ? `≈ ${money(cost, currency)}` : '—'}
      </span>
    </li>
  );
}

export default function Calls({ telemetry, currency, ratePer1k, attributedCost }) {
  const [only, setOnly] = useState('all');

  const calls0 = telemetry?.calls ?? [];

  const calls = useMemo(() => {
    if (only === 'usage') return calls0.filter((c) => c.inputTokens + c.outputTokens > 0);
    if (only === 'failed') return calls0.filter((c) => !c.ok);
    return calls0;
  }, [calls0, only]);

  if (!telemetry) return null;

  const filters = [
    ['all', `Todas (${count(calls0.length)})`],
    ['usage', `Con tokens (${count(calls0.filter((c) => c.inputTokens + c.outputTokens > 0).length)})`],
    ['failed', `Fallidas (${count(calls0.filter((c) => !c.ok).length)})`],
  ];

  return (
    <section className="tapecalls" aria-label="Telemetría por llamada">
      <div className="tapecalls__head">
        <h2 className="tapecalls__title">Evidencia por llamada</h2>
        <p className="tapecalls__note">
          Contexto global de la suscripción. Registros OpenTelemetry GenAI de Application Insights:
          agente, modelo, latencia y tokens cuando se declaran. Pueden incluir eventos y spans de una
          misma ejecución. El coste por registro es una estimación con la tarifa media global.
        </p>
      </div>

      <Assay coverage={telemetry.coverage} currency={currency} attributedCost={attributedCost} />

      <div className="tapecalls__filters">
        {filters.map(([k, label]) => (
          <button
            key={k}
            type="button"
            className="knob"
            aria-pressed={only === k}
            onClick={() => setOnly(k)}
          >
            {label}
          </button>
        ))}
      </div>

      {calls.length === 0 ? (
        <p className="empty">Ninguna llamada coincide con este corte.</p>
      ) : (
        <ol className="calls">
          {calls.slice(0, 120).map((c, i) => (
            <Call key={`${c.operationId ?? 'x'}-${c.at}-${i}`} call={c} currency={currency} ratePer1k={ratePer1k} />
          ))}
        </ol>
      )}

      {calls.length > 120 ? (
        <p className="tapecalls__more">
          Se muestran las 120 llamadas con más evidencia de {count(calls.length)} retenidas,
          sobre {count(telemetry.callCount)} trazadas en la ventana.
        </p>
      ) : null}
    </section>
  );
}
