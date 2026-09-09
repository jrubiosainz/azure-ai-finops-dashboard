const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function subscriptionId(value) {
  const id = String(value ?? '').trim();
  if (!GUID.test(id)) {
    throw new Error(
      'Configura AZURE_SUBSCRIPTION_ID en .env con el ID de tu suscripcion. ' +
      'Puedes consultarlo con "az account list --output table". ' +
      'Para probar sin Azure, ejecuta "npm run demo".',
    );
  }
  return id.toLowerCase();
}

function integer(value, fallback, name, min, max) {
  const n = value == null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} debe ser un entero entre ${min} y ${max}.`);
  }
  return n;
}

export function readConfig(env = process.env, args = process.argv.slice(2)) {
  const flag = String(env.FINOPS_DEMO ?? 'false').toLowerCase();
  if (!['true', 'false'].includes(flag)) {
    throw new Error('FINOPS_DEMO debe ser true o false.');
  }
  const demo = args.includes('--demo') || flag === 'true';
  return {
    demo,
    subscriptionId: demo ? null : subscriptionId(env.AZURE_SUBSCRIPTION_ID),
    days: integer(env.FINOPS_DAYS, 30, 'FINOPS_DAYS', 1, 90),
    port: integer(env.PORT, 5173, 'PORT', 1, 65535),
    host: '127.0.0.1',
  };
}
