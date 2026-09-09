/**
 * The use-case register.
 *
 * This is the panel a FinOps reviewer is actually shown. Every other axis answers
 * "what did Azure bill"; this one answers "what were we doing with it", which the
 * bill cannot say on its own — a model deployment is a child resource and cannot
 * carry an Azure tag, so the grouping has to be declared somewhere else and read
 * back. Here that somewhere is the API Management gateway: the deployments are
 * native tagged operations and the agents are a published registry, so one tag
 * covers both halves of a use case even when it spans accounts.
 *
 * The comparison is deliberately a share, not a table. The question is never
 * "how many tokens exactly" but "which of these two is eating the budget".
 */

import { useMemo, useState } from 'react';
import { money, count, rate, tokens as fmtTokens } from './format.js';

const MAGNITUDES = [
  { id: 'cost', label: 'Coste' },
  { id: 'calls', label: 'Llamadas' },
  { id: 'tokens', label: 'Tokens' },
];

const readOut = (row, id, currency) => {
  if (id === 'cost') return `${money(row.cost, currency)} ${currency}`;
  if (id === 'calls') return `${count(row.calls)} llamadas`;
  return `${fmtTokens(row.tokens)} tokens`;
};

export default function UseCases({ registry, currency }) {
  const [magnitude, setMagnitude] = useState('cost');
  const [open, setOpen] = useState(null);

  const rows = registry?.rows ?? [];
  const gateways = registry?.gateways ?? [];

  const ranked = useMemo(() => {
    const value = (r) => (magnitude === 'cost' ? r.cost : magnitude === 'calls' ? r.calls : r.tokens);
    const top = Math.max(...rows.map(value), 0);
    return rows
      .map((r) => ({ ...r, value: value(r), share: top > 0 ? value(r) / top : 0 }))
      .sort((a, b) => b.value - a.value);
  }, [rows, magnitude]);

  if (!rows.length) return null;

  const totals = registry.totals;

  return (
    <section className="register" aria-label="Casos de uso declarados">
      <header className="register__head">
        <div>
          <h2 className="register__title">Casos de uso</h2>
          <p className="register__note">
            Registro global, independiente de la cascada. Azure factura recursos y medidores, no
            agentes. La pertenencia de los despliegues se declara en la pasarela{' '}
            {gateways.map((g) => (
              <code key={g.name}>{g.name}</code>
            ))}
            : cada despliegue es una operación etiquetada y los agentes van en un registro
            publicado. Un mismo caso puede cruzar cuentas y grupos de recursos sin perder el corte.
          </p>
        </div>

        <div className="register__knobs" role="group" aria-label="Magnitud comparada">
          {MAGNITUDES.map((m) => (
            <button
              key={m.id}
              type="button"
              className="knob"
              aria-pressed={magnitude === m.id}
              onClick={() => setMagnitude(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </header>

      <ol className="register__list">
        {ranked.map((r, i) => {
          const expanded = open === r.id;
          const inShare = r.tokens > 0 ? r.inputTokens / r.tokens : 0;
          return (
            <li
              key={r.id}
              className={`case${expanded ? ' case--open' : ''}`}
              style={{ '--i': i }}
            >
              <button
                type="button"
                className="case__handle"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : r.id)}
              >
                <span className="case__ident">
                  <b className="case__name">{r.display}</b>
                  <span className="case__owner">{r.owner}</span>
                </span>

                <span className="case__bar" aria-hidden="true">
                  <span className="case__fill" style={{ '--share': r.share }} />
                </span>

                <span className="case__value">{readOut(r, magnitude, currency)}</span>
              </button>

              <div className="case__body" aria-hidden={!expanded}>
                <div className="case__inner">
                <p className="case__desc">{r.description}</p>

                <dl className="case__figures">
                  <div>
                    <dt>Coste atribuido</dt>
                    <dd>
                      {money(r.cost, currency)} {currency}
                    </dd>
                  </div>
                  <div>
                    <dt>Llamadas por la pasarela</dt>
                    <dd>
                      {count(r.gatewayCalls)}
                      {r.gatewayFailed ? <em> · {count(r.gatewayFailed)} fallidas</em> : null}
                    </dd>
                  </div>
                  <div>
                    <dt>Coste por llamada APIM (o Monitor si no hay APIM)</dt>
                    <dd>{rate(r.costPerCall)}</dd>
                  </div>
                  <div>
                    <dt>Coste por 1000 tokens</dt>
                    <dd>{rate(r.costPer1kTokens)}</dd>
                  </div>
                  <div>
                    <dt>Latencia media en pasarela</dt>
                    <dd>{r.gatewayDurationMs ? `${Math.round(r.gatewayDurationMs)} ms` : '—'}</dd>
                  </div>
                  <div>
                    <dt>Cuenta que sirve</dt>
                    <dd>
                      {r.account} <em>· {r.resourceGroup}</em>
                    </dd>
                  </div>
                </dl>

                <div className="split" role="img" aria-label={`${fmtTokens(r.inputTokens)} tokens de entrada y ${fmtTokens(r.outputTokens)} de salida`}>
                  <div className="split__bar">
                    <span className="split__in" style={{ '--share': inShare }} />
                  </div>
                  <p className="split__read">
                    <b>{fmtTokens(r.inputTokens)}</b> de entrada · <b>{fmtTokens(r.outputTokens)}</b> de
                    salida
                  </p>
                </div>

                <div className="roster">
                  <div className="roster__col">
                    <p className="roster__label">
                      Despliegues etiquetados
                      <span>
                        {count(r.billedDeployments)} de {count(r.deploymentCount)} con coste atribuido
                      </span>
                    </p>
                    <ul>
                      {r.deploymentRows.map((d) => (
                        <li key={d.name} className={d.billed ? '' : 'is-unbilled'}>
                          <b>{d.name}</b>
                          <span>{d.model}</span>
                          <em>
                            {count(d.gatewayCalls || d.calls)} llam · {money(d.cost, currency)}
                          </em>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="roster__col">
                    <p className="roster__label">
                      Agentes asignados
                      <span>
                        {count(r.registeredAgents)} de {count(r.agentCount)} localizados sin ambigüedad
                      </span>
                    </p>
                    <ul>
                      {r.agentRows.map((a) => (
                        <li key={a.name} className={a.registered ? '' : 'is-unbilled'}>
                          <b>{a.name}</b>
                          <span>{a.model || 'sin despliegue declarado'}</span>
                          <em>
                            {a.registered
                              ? `${count(a.calls)} llam · ${money(a.cost, currency)}`
                              : 'no localizado o nombre ambiguo'}
                          </em>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                <p className="case__trace">
                  Etiqueta <code>{r.id}</code> · producto{' '}
                  {r.products.map((p) => (
                    <code key={p}>{p}</code>
                  ))}{' '}
                  · {r.operations.length} operaciones en <code>{r.gatewayUrl}</code>. El coste por
                  agente se reparte a partes iguales entre los que declaran un mismo despliegue,
                  como estimación; no mide ejecuciones individuales de cada agente.
                </p>
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      <p className="register__foot">
        {count(totals.deployments)} despliegues y {count(totals.agents)} agentes agrupados en{' '}
        {count(rows.length)} casos, {money(totals.cost, currency)} {currency} y{' '}
        {fmtTokens(totals.tokens)} tokens. Se reagrupa el coste derivado por despliegue. No incluye toda
        la factura de la suscripción ni el coste de operar la pasarela. APIM y Monitor pueden contar
        tráfico diferente; las tarifas por llamada requieren interpretar esa diferencia.
      </p>
    </section>
  );
}
