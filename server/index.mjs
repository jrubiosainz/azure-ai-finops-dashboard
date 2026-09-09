import express from 'express';
import compression from 'compression';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runSync, defaultRange } from './sync.mjs';
import { readCache, modelCacheKey } from './cache.mjs';
import { getSubscription } from './azure.mjs';
import { readConfig } from './config.mjs';
import { createDemoData } from './demo.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export async function createApp(config, services = {}) {
  const sync = services.runSync ?? runSync;
  const read = services.readCache ?? readCache;
  const subscription = services.getSubscription ?? getSubscription;
  const demo = config.demo ? createDemoData({ days: config.days }) : null;
  const app = express();
  let running = null;
  let progress = { phase: 'idle', detail: null };

  app.disable('x-powered-by');
  app.use(compression());
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!LOCAL_HOSTS.has(req.hostname)) {
      return res.status(403).json({ error: 'La API solo admite acceso local.' });
    }
    const origin = req.get('origin');
    if (origin) {
      let allowed = false;
      try {
        const url = new URL(origin);
        allowed = url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname) &&
          [config.port, 5174].includes(Number(url.port));
      } catch {
        // Malformed origins must be rejected, never treated as a local caller.
      }
      if (!allowed) return res.status(403).json({ error: 'Origen no autorizado.' });
    }
    next();
  });
  app.use(express.json({ limit: '8kb' }));

  function startSync() {
    if (running) return running;
    progress = { phase: 'starting', detail: 'Preparando lectura de Azure', at: Date.now() };
    running = Promise.resolve().then(() => sync({
      subscriptionId: config.subscriptionId,
      ...defaultRange(config.days),
      onProgress: (step) => { progress = { ...step, at: Date.now() }; },
    })).catch((error) => {
      progress = { phase: 'failed', detail: error.message, at: Date.now() };
      throw error;
    }).finally(() => { running = null; });
    return running;
  }

  const key = () => modelCacheKey(config.subscriptionId, defaultRange(config.days));
  const snapshot = (data, cachedAt) => ({
    ...data,
    mode: demo ? 'demo' : 'azure',
    cachedAt,
    stale: Date.now() - new Date(cachedAt).getTime() > 4 * 60 * 60 * 1000,
    syncing: Boolean(running),
  });

  app.get('/api/health', async (_req, res) => {
    if (demo) return res.json({ ok: true, mode: 'demo', authenticated: false, subscription: demo.subscription });
    try {
      const sub = await subscription(config.subscriptionId);
      res.json({
        ok: true,
        mode: 'azure',
        authenticated: true,
        subscription: { id: sub.subscriptionId, name: sub.displayName, state: sub.state },
        range: defaultRange(config.days),
      });
    } catch (error) {
      res.status(502).json({
        ok: false,
        mode: 'azure',
        authenticated: false,
        error: error.message,
        hint: 'Ejecuta az login y comprueba el tenant, la suscripcion y los permisos del README.',
      });
    }
  });

  app.get('/api/finops', async (_req, res) => {
    try {
      if (demo) return res.json(snapshot(demo, demo.generatedAt));
      const hit = await read(key());
      if (hit) return res.json(snapshot(hit.data, hit.cachedAt));
      const data = await startSync();
      res.json(snapshot(data, data.generatedAt));
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
  });

  app.post('/api/refresh', async (req, res) => {
    if (req.body != null && (!req.body || Array.isArray(req.body) || Object.keys(req.body).length)) {
      return res.status(400).json({ error: 'Configura la suscripcion y FINOPS_DAYS en .env y reinicia el servidor.' });
    }
    try {
      const data = demo ?? await startSync();
      res.json({ ok: true, mode: demo ? 'demo' : 'azure', generatedAt: data.generatedAt, durationMs: data.durationMs });
    } catch (error) {
      res.status(502).json({ ok: false, error: error.message });
    }
  });

  app.get('/api/progress', (_req, res) => res.json({ syncing: Boolean(running), ...progress }));

  const dist = path.join(root, 'web', 'dist');
  let hasDist = false;
  try {
    await fs.access(path.join(dist, 'index.html'));
    hasDist = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Ruta de API no disponible.' }));
  if (hasDist) {
    app.use(express.static(dist, { maxAge: '1h', index: false }));
    app.get('*', (_req, res) => {
      res.set('Cache-Control', 'no-cache');
      res.sendFile(path.join(dist, 'index.html'));
    });
  }
  app.use((error, _req, res, _next) => {
    console.error(error.message);
    const status = error.status >= 400 && error.status < 600 ? error.status : 500;
    res.status(status).json({ error: error.message });
  });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = readConfig();
    const app = await createApp(config);
    app.listen(config.port, config.host, () => {
      console.log(`Dashboard: http://${config.host}:${config.port}`);
      console.log(config.demo
        ? 'DEMO: datos ficticios. No se consulta Azure ni se genera consumo.'
        : `Azure: ventana de ${config.days} dias. La primera lectura puede tardar varios minutos.`);
      console.log('Solo acceso local. Ctrl+C para detener.');
    }).on('error', (error) => {
      console.error(error.code === 'EADDRINUSE'
        ? `El puerto ${config.port} esta ocupado. Cambia PORT en .env.`
        : error.message);
      process.exitCode = 1;
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
