/**
 * The board.
 *
 * The old board asked seven questions in parallel and answered each in its own table.
 * This one asks a single question — where did the money go — and lets the reader walk the
 * answer down. The cascade is the instrument: choose an axis, choose what to measure,
 * then cut the estate open one level at a time. Every ledger and every quotation below
 * re-quotes against whatever the cascade currently has open.
 *
 * Nothing here invents a number. Where Azure cannot attribute, the row says so, and where
 * only an agent's own telemetry could attribute, the assay says how little of it exists.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Quote, Mark, Ledger } from './Board.jsx';
import Cascade, { METRICS } from './Cascade.jsx';
import Calls from './Calls.jsx';
import UseCases from './UseCases.jsx';
import Tape from './Tape.jsx';
import { buildView } from './scope.js';
import { money, rate, count, tokens, pct, plural, dateTime, sortBy } from './format.js';

const REFRESH_POLL_MS = 2500;

const AXES = [
  { id: 'estate', label: 'Infraestructura', hint: 'Grupo → recurso → despliegue → medidor' },
  { id: 'foundry', label: 'Foundry', hint: 'Cuenta → proyecto → agente → modelo' },
  { id: 'usecase', label: 'Caso de uso', hint: 'Caso → agente → despliegue → modelo' },
  { id: 'telemetry', label: 'Telemetría', hint: 'Aplicación → agente → operación → modelo' },
];

const eq = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

export default function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [phase, setPhase] = useState(null);

  const [axis, setAxis] = useState('estate');
  const [metric, setMetric] = useState('cost');
  const [path, setPath] = useState({});

  const [sorts, setSorts] = useState({
    deployments: { key: 'cost', dir: 'desc' },
    agents: { key: 'estimatedCost', dir: 'desc' },
    meters: { key: 'cost', dir: 'desc' },
  });

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/finops');
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      setData(await res.json());
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // While a sync runs the board reports which phase Azure is in, because a 90 second
  // wait with no explanation reads as a hang.
  useEffect(() => {
    if (!syncing) return undefined;
    const id = setInterval(async () => {
      try {
        const p = await (await fetch('/api/progress')).json();
        setPhase(p.detail ?? null);
        if (!p.syncing) {
          setSyncing(false);
          setPhase(null);
          if (p.phase === 'failed') setError(p.detail);
          else load();
        }
      } catch {
        /* the poll is advisory; the refresh promise settles regardless */
      }
    }, REFRESH_POLL_MS);
    return () => clearInterval(id);
  }, [syncing, load]);

  async function refresh() {
    setSyncing(true);
    setPhase('Iniciando sincronización');
    try {
      const res = await fetch('/api/refresh', { method: 'POST' });
      const result = await res.json();
      if (!res.ok || !result.ok) throw new Error(result.error ?? `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSyncing(false);
      setPhase(null);
    }
  }

  const sortOn = (table) => (key) =>
    setSorts((s) => ({
      ...s,
      [table]: { key, dir: s[table].key === key && s[table].dir === 'desc' ? 'asc' : 'desc' },
    }));

  // Picking a level discards everything below it: a resource chosen under one group is
  // meaningless under another.
  const pick = useCallback(
    (levelId, value) => {
      setPath((p) => {
        const order = LEVEL_ORDER[axis];
        const at = order.indexOf(levelId);
        const next = {};
        for (const id of order.slice(0, at)) if (p[id]) next[id] = p[id];
        if (value) next[levelId] = value;
        return next;
      });
    },
    [axis],
  );

  const changeAxis = useCallback((next) => {
    setAxis(next);
    setPath({});
    if (next === 'telemetry') setMetric('calls');
    else setMetric('cost');
  }, []);

  /* ---------------- The cascade: levels for the active axis ---------------- */

  const levels = useMemo(() => (data ? buildLevels(axis, data, path) : []), [axis, data, path]);

  /* ---------------- Everything below re-quotes against the drill ---------------- */

  const view = useMemo(() => (data ? buildView(data, axis, path) : null), [data, axis, path]);

  if (error && !data) {
    return (
      <main className="curtain">
        <p className="curtain__title">El tablón no puede leer Azure</p>
        <p>{error}</p>
        <p>
          Configura <code>.env</code>, inicia sesión con <code>az login</code> y comprueba los
          permisos del README. Para probar sin Azure, ejecuta <code>npm run demo</code>.
        </p>
      </main>
    );
  }

  if (!view) {
    return (
      <main className="curtain">
        <p className="curtain__title">Registrando el tablón</p>
        <p>
          Primera lectura de Cost Management, Azure Monitor, Application Insights y el plano de
          datos de Foundry. La sincronización completa tarda algo más de un minuto.
        </p>
      </main>
    );
  }

  const c = view.currency;
  const tel = data.telemetry;

  return (
    <>
      {data.mode === 'demo' ? (
        <aside className="mode-banner" role="status">
          <strong>DEMO · DATOS FICTICIOS</strong> · No se consulta Azure. Importes y nombres inventados; no son precios de catálogo.
        </aside>
      ) : null}
      {error ? <p className="error-banner" role="alert">No se pudo actualizar: {error}. Se conserva la última lectura.</p> : null}
      <header className="board">
        <div className="board__head">
          <div>
            <h1 className="board__title">Tablón de cotizaciones&nbsp;· Gasto en IA</h1>
            <p className="board__sub">
              {data.subscription.name} · {data.range.from} → {data.range.to} · {c}
            </p>
          </div>
          <div className="board__actions">
            <p className="stamp">
              <b>Última lectura</b>
              {dateTime(data.cachedAt)}
              {data.stale ? ' · caducada' : ''}
            </p>
            <button type="button" className="piston" onClick={refresh} disabled={syncing || data.mode === 'demo'}>
              <span className="piston__led" />
              {data.mode === 'demo' ? 'Ejemplo sin conexión' : syncing ? (phase ?? 'Sincronizando') : 'Releer Azure'}
            </button>
          </div>
        </div>

        <div className="quotes">
          <Quote
            tab="Gasto total"
            value={money(view.spend, c)}
            unit={c}
            note={
              view.byDeploymentOnly
                ? `Importe de los despliegues relacionados${view.open ? ` en ${view.open}` : ''}; no incluye toda la infraestructura.`
                : view.open
                  ? `Sólo ${view.open}.`
                  : 'Suscripción completa, según Cost Management.'
            }
          />
          <Quote
            tab="Gasto IA"
            value={money(view.aiSpend, c)}
            unit={c}
            note={
              view.byDeploymentOnly
                ? `${pct(view.subscriptionAiShare, 4)} del gasto en IA de la suscripción.`
                : `${pct(view.spend > 0 ? view.aiSpend / view.spend : 0)} del gasto de la ventana.`
            }
          />
          <Quote
            tab="Gasto en tokens"
            value={money(view.tokenSpend, c)}
            unit={c}
            note="Medidores de tokens, imágenes y embeddings; excluye búsqueda, cómputo y almacenamiento."
          />
          <Quote tab="Llamadas" value={count(view.calls)} note={view.meterOnly ? 'No hay llamadas desglosadas por medidor.' : 'Peticiones a modelo medidas por Azure Monitor; no usuarios ni conversaciones.'} />
          <Quote
            tab="Coste / llamada"
            value={money(view.costPerCall, c)}
            unit={c}
            note="Gasto en tokens dividido entre llamadas medidas."
          />
          <Quote
            tab="Coste / 1k tokens"
            value={rate(view.costPer1k)}
            unit={c}
            note={`${tokens(view.inTok)} entrada · ${tokens(view.outTok)} salida · ${pct(view.inputShare)} entrada.`}
          />
        </div>
      </header>

      <main className="shell">
        <section className="console" aria-label="Registros del tablón">
          <div className="console__bank">
            <p className="console__label">
              Eje
              <span>Por dónde se corta el gasto.</span>
            </p>
            <div className="console__knobs">
              {AXES.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className="knob knob--axis"
                  aria-pressed={axis === a.id}
                  title={a.hint}
                  onClick={() => changeAxis(a.id)}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>

          <div className="console__bank">
            <p className="console__label">
              Magnitud
              <span>Qué mide el ancho de cada banda.</span>
            </p>
            <div className="console__knobs">
              {Object.entries(METRICS).map(([k, m]) => (
                <button
                  key={k}
                  type="button"
                  className="knob"
                  aria-pressed={metric === k}
                  disabled={axis === 'telemetry' && k === 'cost'}
                  onClick={() => setMetric(k)}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        </section>
        <p className="scope-note">
          {axis === 'telemetry'
            ? 'Telemetría: la cascada recorre la muestra retenida. La cabecera y las tablas de costes siguen mostrando la suscripción.'
            : 'La cascada selecciona infraestructura o despliegues relacionados. Los importes por proyecto y agente son repartos, no facturas propias.'}
          {' '}La cinta diaria, la evidencia por llamada y el registro inferior de casos de uso mantienen su contexto global.
        </p>
      </main>

      <Cascade
        // Axis levels share ids (`deployment`, `model`), so React would otherwise reuse
        // the rails across a change of axis and animate stale rows into the new cut.
        key={axis}
        levels={levels}
        path={path}
        metric={metric}
        currency={c}
        onPick={pick}
        onReset={() => setPath({})}
      />

      <Tape timeline={data.timeline} currency={c} />

      <main className="shell">
        <Ledger
          title="Despliegues"
          note={
            view.open
              ? `${plural(view.deployments.length, 'despliegue', 'despliegues')} bajo ${view.open}.`
              : 'Cada despliegue de modelo con su consumo medido y su tarifa derivada.'
          }
          columns={DEPLOYMENT_COLUMNS(c)}
          rows={sortBy(view.deployments, sorts.deployments.key, sorts.deployments.dir).map((r) => ({
            ...r,
            __key: r.id,
          }))}
          sort={sorts.deployments}
          onSort={sortOn('deployments')}
        />

        <Ledger
          title="Agentes de Foundry"
          note={
            view.duplicateAgents > 0
              ? `Reparto por agente dentro de cada despliegue compartido. ${plural(
                  view.duplicateAgents,
                  'registro repetido',
                  'registros repetidos',
                )}: mismo nombre, identificador distinto.`
              : 'Reparto por agente dentro de cada despliegue compartido.'
          }
          columns={AGENT_COLUMNS(c)}
          rows={sortBy(view.agents, sorts.agents.key, sorts.agents.dir).map((r) => ({ ...r, __key: r.id }))}
          sort={sorts.agents}
          onSort={sortOn('agents')}
          empty="Ningún agente registrado bajo este corte."
        />

        <Ledger
          title="Medidores facturados"
          note="La línea de factura real, tal y como Cost Management la emite."
          columns={METER_COLUMNS(c)}
          rows={sortBy(view.meters, sorts.meters.key, sorts.meters.dir).map((r) => ({
            ...r,
            __key: r.id ?? `${r.account}::${r.name}`,
          }))}
          sort={sorts.meters}
          onSort={sortOn('meters')}
          empty="Ningún medidor de inferencia bajo este corte."
        />

        {tel ? (
          <Calls
            telemetry={tel}
            currency={c}
            ratePer1k={data.totals.costPer1kTokens}
            attributedCost={data.totals.attributedAiCost}
          />
        ) : null}

        <UseCases registry={data.useCases} currency={c} />

        <section className="notice">
          <p className="notice__label">Qué prueba cada cifra</p>
          <p>
            <strong>Facturado</strong> es el coste registrado en Cost Management, sujeto a actualización. <strong>Medido</strong> sale de
            Azure Monitor y es consumo real por despliegue. <strong>Derivado</strong> divide lo facturado
            entre lo medido o atribuye por cuota de tokens. <strong>Estimado</strong> reparte un despliegue entre los agentes que
            lo declaran, porque Azure no factura por agente.
          </p>
          <p>
            La atribución por agente, conversación, usuario o IP no existe en la factura ni en las métricas:
            sólo la emite el propio código que llama al modelo, como trazas OpenTelemetry GenAI hacia
            Application Insights. Esa telemetría <strong>sí está aquí</strong> y se lee en «Evidencia por
            llamada», pero hoy cubre{' '}
            <strong>{pct(tel?.coverage?.usageShare ?? 0, 2)}</strong> al comparar registros con tokens y peticiones
            medidas. No es una conciliación uno a uno ni corrige automáticamente el reparto por agente.
          </p>
          <details>
            <summary>Cómo cerrar el hueco de atribución</summary>
            <ul>
              <li>
                Instrumentar cada aplicación llamante con el SDK de Azure Monitor OpenTelemetry y activar la
                captura GenAI, para que emita <code>gen_ai.usage.input_tokens</code>,{' '}
                <code>gen_ai.usage.output_tokens</code> y <code>gen_ai.agent.name</code> en cada span.
              </li>
              <li>
                Si la política de privacidad lo permite, emitir identificadores seudónimos de usuario y sesión.
                No habilitar la captura de prompts, datos personales o IP sin aprobación. Hay{' '}
                {count(tel?.coverage?.maskedAddresses ?? 0)} registros con IP enmascarada.
              </li>
              <li>
                Etiquetar cada cuenta de Foundry con centro de coste y equipo, para que la factura se pueda
                repartir sin depender de la telemetría.
              </li>
              <li>
                Ampliar la retención de los workspaces por encima de los 30 días si FinOps necesita cerrar
                trimestres.
              </li>
            </ul>
          </details>
          {data.warnings?.length ? (
            <details>
              <summary>Avisos de la última sincronización ({data.warnings.length})</summary>
              <ul>
                {data.warnings.slice(0, 12).map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      </main>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Level construction
 * ------------------------------------------------------------------ */

const LEVEL_ORDER = {
  estate: ['group', 'resource', 'deployment', 'meter'],
  foundry: ['account', 'project', 'agent', 'model'],
  usecase: ['usecase', 'agent', 'deployment', 'model'],
  telemetry: ['app', 'agent', 'operation', 'model'],
};

const sum = (rows, key) => rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);

function buildLevels(axis, data, path) {
  if (axis === 'estate') return estateLevels(data, path);
  if (axis === 'foundry') return foundryLevels(data, path);
  if (axis === 'usecase') return usecaseLevels(data, path);
  return telemetryLevels(data, path);
}

function level(id, label, rows, extra = {}) {
  return {
    id,
    label,
    rows,
    total: sum(rows, 'cost'),
    ...extra,
  };
}

function estateLevels(data, path) {
  const groups = data.groups.map((g) => ({
    key: g.name,
    label: g.name,
    cost: g.cost,
    calls: g.calls ?? 0,
    tokens: (g.inputTokens ?? 0) + (g.outputTokens ?? 0),
    ai: g.aiCost > 0,
  }));

  const resources = buildView(data, 'estate', { group: path.group }).resources.map((r) => {
    const a = data.accounts.find((account) => eq(account.id, r.id));
    return {
      key: r.id, label: r.name, cost: r.cost, calls: a?.calls ?? 0,
      tokens: (a?.inputTokens ?? 0) + (a?.outputTokens ?? 0), ai: r.isAi || r.isFoundry,
    };
  });

  // Only Cognitive Services resources carry deployments, so the resource level is where
  // the non-AI half of the estate stops being decomposable.
  const deployments = buildView(data, 'estate', { group: path.group, resource: path.resource }).deployments
    .map((d) => ({
      key: d.id,
      label: d.name,
      cost: d.cost,
      calls: d.calls,
      tokens: d.totalTokens,
      ai: true,
    }));

  const meters = buildView(data, 'estate', {
    group: path.group, resource: path.resource, deployment: path.deployment,
  }).allMeters
    .map((m) => ({ key: m.id ?? m.name, label: m.name, cost: m.cost, calls: 0, tokens: 0, ai: m.kind !== 'other' }));

  return [
    level('group', 'Grupo de recursos', groups),
    level('resource', 'Recurso', resources),
    level('deployment', 'Despliegue', deployments, {
      empty: 'Este tramo no tiene despliegues de modelo: el gasto es de servicio, no de inferencia.',
    }),
    level('meter', 'Medidor facturado', meters),
  ];
}

function foundryLevels(data, path) {
  const accounts = data.accounts.map((a) => ({
    key: a.id,
    label: a.name,
    cost: a.cost,
    calls: a.calls ?? 0,
    tokens: (a.inputTokens ?? 0) + (a.outputTokens ?? 0),
    ai: true,
  }));

  const projects = buildView(data, 'foundry', { account: path.account }).projects
    .map((p) => ({
      key: p.id,
      label: p.displayName?.split('/').pop() ?? p.name,
      cost: p.estimatedCost,
      calls: p.estimatedCalls,
      tokens: (p.estimatedInputTokens ?? 0) + (p.estimatedOutputTokens ?? 0),
      ai: true,
    }));

  const agents = buildView(data, 'foundry', { account: path.account, project: path.project }).agents
    .map((a) => ({
      key: a.id,
      label: a.name,
      cost: a.estimatedCost,
      calls: a.estimatedCalls,
      tokens: (a.estimatedInputTokens ?? 0) + (a.estimatedOutputTokens ?? 0),
      ai: true,
    }));

  const models = new Map();
  for (const d of buildView(data, 'foundry', {
    account: path.account, project: path.project, agent: path.agent,
  }).deployments) {
    const row = models.get(d.modelKey) ?? {
      key: d.modelKey, label: d.model, cost: 0, calls: 0, tokens: 0, ai: true,
    };
    row.cost += d.cost;
    row.calls += d.calls;
    row.tokens += d.totalTokens;
    models.set(d.modelKey, row);
  }

  return [
    level('account', 'Cuenta de Foundry', accounts),
    level('project', 'Proyecto', projects, { empty: 'Esta cuenta no expone proyectos de Foundry.' }),
    level('agent', 'Agente', agents, { empty: 'Ningún agente registrado en este tramo.' }),
    level('model', 'Modelo relacionado', [...models.values()]),
  ];
}

/**
 * The use-case axis reads membership from the gateway registry rather than from Azure
 * resource tags, because a model deployment is a child resource and cannot carry one.
 * A case therefore spans accounts and resource groups freely, which is exactly the cut
 * FinOps asks for and the only cut the bill cannot make on its own.
 */
function usecaseLevels(data, path) {
  const uc = data.useCases;
  if (!uc?.rows?.length) {
    return LEVEL_ORDER.usecase.map((id, i) =>
      level(id, ['Caso de uso', 'Agente', 'Despliegue', 'Modelo'][i], [], {
        empty: 'Ninguna pasarela de API declara casos de uso en esta suscripción.',
      }),
    );
  }

  const cases = uc.rows.map((r) => ({
    key: r.id,
    label: r.display,
    cost: r.cost,
    calls: r.calls,
    tokens: r.tokens,
    ai: true,
  }));

  const inScope = uc.rows.filter((r) => !path.usecase || r.id === path.usecase);

  const agents = inScope
    .flatMap((r) => r.agentRows.map((a) => ({ ...a, case: r.id })))
    .map((a) => ({
      key: `${a.account}/${a.name}`.toLowerCase(),
      label: a.name,
      cost: a.cost,
      calls: a.calls,
      tokens: a.tokens ?? 0,
      ai: true,
    }));

  // An agent declares the deployment it runs on, so picking one narrows the rail below it
  // to the deployment actually serving that agent.
  const declared = new Set(
    inScope
      .flatMap((r) => r.agentRows)
      .filter((a) => !path.agent || `${a.account}/${a.name}`.toLowerCase() === path.agent)
      .map((a) => a.model)
      .filter(Boolean),
  );
  const narrow = Boolean(path.agent) && declared.size > 0;

  const deployments = inScope
    .flatMap((r) => r.deploymentRows)
    .filter((d) => !narrow || declared.has(d.name))
    .map((d) => ({
      key: `${d.account}/${d.name}`.toLowerCase(),
      label: d.name,
      cost: d.cost,
      // The gateway counts every brokered call; Azure Monitor only counts what it metered.
      calls: d.gatewayCalls || d.calls,
      tokens: d.inputTokens + d.outputTokens,
      ai: true,
    }));

  const models = new Map();
  for (const d of inScope.flatMap((r) => r.deploymentRows)) {
    if (!d.model) continue;
    if (narrow && !declared.has(d.name)) continue;
    if (path.deployment && `${d.account}/${d.name}`.toLowerCase() !== path.deployment) continue;
    const prev = models.get(d.model) ?? { cost: 0, calls: 0, tokens: 0 };
    models.set(d.model, {
      cost: prev.cost + d.cost,
      calls: prev.calls + (d.gatewayCalls || d.calls),
      tokens: prev.tokens + d.inputTokens + d.outputTokens,
    });
  }

  return [
    level('usecase', 'Caso de uso', cases),
    level('agent', 'Agente asignado', agents, {
      empty: 'Ningún agente de este corte declara un despliegue con gasto.',
    }),
    level('deployment', 'Despliegue etiquetado', deployments, {
      empty: 'Ninguna operación etiquetada bajo este corte.',
    }),
    level(
      'model',
      'Modelo',
      [...models].map(([m, v]) => ({ key: m, label: m, ...v, ai: true })),
    ),
  ];
}

function telemetryLevels(data, path) {
  const t = data.telemetry;
  if (!t) {
    const none = [];
    return LEVEL_ORDER.telemetry.map((id, i) =>
      level(id, ['Aplicación', 'Agente', 'Operación', 'Modelo'][i], none, {
        empty: 'No hay telemetría por llamada en la ventana.',
      }),
    );
  }

  const calls = t.calls ?? [];
  const byApp = calls.filter((c) => !path.app || c.app === path.app);
  const byAgent = byApp.filter((c) => !path.agent || c.agentName === path.agent);
  const byOperation = byAgent.filter((c) => !path.operation || c.operation === path.operation);
  const shape = (rows, field) => {
    const groups = new Map();
    for (const c of rows) {
      if (!c[field]) continue;
      const r = groups.get(c[field]) ?? { key: c[field], label: c[field], cost: 0, calls: 0, tokens: 0, ai: true };
      r.calls++;
      r.tokens += c.inputTokens + c.outputTokens;
      groups.set(c[field], r);
    }
    return [...groups.values()];
  };

  return [
    level('app', 'Aplicación (muestra)', shape(calls, 'app'), {
      empty: 'Ninguna aplicación emite trazas GenAI en la ventana.',
    }),
    level('agent', 'Agente declarado', shape(byApp, 'agentName'), {
      empty: 'Las trazas de este tramo no declaran nombre de agente.',
    }),
    level('operation', 'Operación', shape(byAgent, 'operation'), {
      empty: 'Las trazas no declaran operación GenAI.',
    }),
    level('model', 'Modelo declarado', shape(byOperation, 'model'), {
      empty: 'Las trazas no declaran modelo.',
    }),
  ];
}

/* ------------------------------------------------------------------ *
 * Ledger columns
 * ------------------------------------------------------------------ */

const num = (v, render) => (
  <span className={Number(v) > 0 ? 'num' : 'num num--zero'}>{render}</span>
);

const DEPLOYMENT_COLUMNS = (c) => [
  {
    key: 'name',
    label: 'Despliegue',
    render: (r) => (
      <>
        <span className="cell-id">{r.name}</span>
        <span className="cell-sub">
          {r.accountName} · {r.resourceGroup} · {r.skuName}
        </span>
      </>
    ),
  },
  { key: 'model', label: 'Modelo', render: (r) => r.model },
  { key: 'calls', label: 'Llamadas', render: (r) => num(r.calls, count(r.calls)) },
  { key: 'inputTokens', label: 'Entrada', render: (r) => num(r.inputTokens, tokens(r.inputTokens)) },
  { key: 'outputTokens', label: 'Salida', render: (r) => num(r.outputTokens, tokens(r.outputTokens)) },
  { key: 'cost', label: `Coste atrib. ${c}`, render: (r) => num(r.cost, money(r.cost, c)) },
  { key: 'costPerCall', label: 'Por llamada', render: (r) => num(r.costPerCall, money(r.costPerCall, c)) },
  { key: 'confidence', label: 'Procedencia', render: (r) => <Mark level={r.confidence} /> },
];

const AGENT_COLUMNS = (c) => [
  {
    key: 'name',
    label: 'Agente',
    render: (r) => (
      <>
        <span className="cell-id">{r.name}</span>
        <span className="cell-sub">
          {r.projectName} · {r.id}
        </span>
      </>
    ),
  },
  { key: 'modelName', label: 'Modelo', render: (r) => r.modelName ?? r.model ?? '—' },
  {
    key: 'sharesDeploymentWith',
    label: 'Comparte',
    hint: 'Otros agentes registrados que comparten el mismo despliegue; excluye el agente de esta fila.',
    render: (r) => num(r.sharesDeploymentWith, count(r.sharesDeploymentWith)),
  },
  { key: 'estimatedCalls', label: 'Llamadas', render: (r) => num(r.estimatedCalls, count(r.estimatedCalls)) },
  {
    key: 'estimatedCost',
    label: `Coste ${c}`,
    render: (r) => num(r.estimatedCost, money(r.estimatedCost, c)),
  },
  {
    key: 'estimatedCostPerCall',
    label: 'Por llamada',
    render: (r) => num(r.estimatedCostPerCall, money(r.estimatedCostPerCall, c)),
  },
  { key: 'confidence', label: 'Procedencia', render: (r) => <Mark level={r.confidence} /> },
];

const METER_COLUMNS = (c) => [
  {
    key: 'name',
    label: 'Medidor',
    render: (r) => (
      <>
        <span className="cell-id">{r.name}</span>
        <span className="cell-sub">
          {r.account} · {r.resourceGroup}
        </span>
      </>
    ),
  },
  { key: 'model', label: 'Modelo', render: (r) => r.model ?? '—' },
  { key: 'direction', label: 'Sentido', render: (r) => DIRECTION[r.direction] ?? r.direction },
  { key: 'kind', label: 'Clase', render: (r) => KIND[r.kind] ?? r.kind },
  { key: 'cost', label: `Coste ${c}`, render: (r) => num(r.cost, money(r.cost, c)) },
];

const DIRECTION = { input: 'entrada', output: 'salida', cachedInput: 'entrada en caché', cacheWrite: 'escritura de caché', other: '—' };
const KIND = {
  tokens: 'tokens',
  images: 'imágenes',
  embeddings: 'embeddings',
  audio: 'audio',
  finetuning: 'ajuste fino',
  compute: 'cómputo',
  provisioned: 'provisionado',
  other: 'otro',
};
