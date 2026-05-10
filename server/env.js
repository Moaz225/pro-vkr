function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function requireEnv(name) {
  const raw = process.env[name];
  const v = typeof raw === 'string' ? raw.trim() : raw;
  if (!isNonEmptyString(v)) {
    const err = new Error(`Missing required env var: ${name}`);
    err.code = 'ERR_MISSING_ENV';
    throw err;
  }
  return v;
}

function optionalEnv(name, fallback = undefined) {
  const raw = process.env[name];
  const v = typeof raw === 'string' ? raw.trim() : raw;
  return isNonEmptyString(v) ? v : fallback;
}

function parseBool(name, fallback = false) {
  const v = optionalEnv(name, null);
  if (v === null) return fallback;
  if (v === '1' || v.toLowerCase() === 'true') return true;
  if (v === '0' || v.toLowerCase() === 'false') return false;
  const err = new Error(`Invalid boolean env var: ${name}=${JSON.stringify(v)} (expected 0/1/true/false)`);
  err.code = 'ERR_INVALID_ENV';
  throw err;
}

function parseIntEnv(name, fallback) {
  const v = optionalEnv(name, null);
  if (v === null) return fallback;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) {
    const err = new Error(`Invalid integer env var: ${name}=${JSON.stringify(v)}`);
    err.code = 'ERR_INVALID_ENV';
    throw err;
  }
  return n;
}

function mustBeHttpUrl(name, value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    const err = new Error(`Invalid URL in env var: ${name}`);
    err.code = 'ERR_INVALID_ENV';
    throw err;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    const err = new Error(`Invalid URL protocol for ${name}: ${u.protocol} (expected http/https)`);
    err.code = 'ERR_INVALID_ENV';
    throw err;
  }
  return u.toString().replace(/\/+$/, '');
}

function parseCorsOrigins(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  if (raw === '*') return ['*'];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function validateAndLoadEnv() {
  const nodeEnv = optionalEnv('NODE_ENV', 'development');
  const isProd = nodeEnv === 'production';

  const port = parseIntEnv('PORT', 3000);

  const corsOriginRaw = optionalEnv('CORS_ORIGIN', '*');
  const corsOrigins = parseCorsOrigins(corsOriginRaw);
  if (isProd && (corsOrigins.length === 0 || corsOrigins.includes('*'))) {
    const err = new Error('CORS_ORIGIN must be an explicit allowlist in production (comma-separated origins)');
    err.code = 'ERR_INVALID_ENV';
    throw err;
  }

  const databaseUrl = requireEnv('DATABASE_URL');

  const publicBaseUrl = mustBeHttpUrl('PUBLIC_BASE_URL', requireEnv('PUBLIC_BASE_URL'));
  if (isProd && !publicBaseUrl.startsWith('https://')) {
    const err = new Error('PUBLIC_BASE_URL must be https:// in production');
    err.code = 'ERR_INVALID_ENV';
    throw err;
  }

  const yookassaShopId = requireEnv('YOOKASSA_SHOP_ID');
  const yookassaSecretKey = requireEnv('YOOKASSA_SECRET_KEY');
  const yookassaCurrency = optionalEnv('YOOKASSA_CURRENCY', 'RUB');

  const trustProxy = parseBool('TRUST_PROXY', false);

  // For later phases (sessions/cookies). Not required yet, but we read them now.
  const sessionSecret = optionalEnv('SESSION_SECRET', '');
  if (isProd && !sessionSecret) {
    const err = new Error('SESSION_SECRET is required in production');
    err.code = 'ERR_INVALID_ENV';
    throw err;
  }
  const cookieSecure = parseBool('COOKIE_SECURE', isProd);

  const smtpHost = optionalEnv('SMTP_HOST', '');
  const smtpPort = parseIntEnv('SMTP_PORT', 587);
  const smtpSecure = parseBool('SMTP_SECURE', false);
  const smtpUser = optionalEnv('SMTP_USER', '');
  const smtpPass = optionalEnv('SMTP_PASS', '');
  const mailFrom = optionalEnv('MAIL_FROM', '');
  const mailToManager = optionalEnv('MAIL_TO_MANAGER', '');

  return {
    nodeEnv,
    isProd,
    port,
    corsOrigins,
    databaseUrl,
    publicBaseUrl,
    yookassaShopId,
    yookassaSecretKey,
    yookassaCurrency,
    trustProxy,
    sessionSecret,
    cookieSecure,
    smtpHost,
    smtpPort,
    smtpSecure,
    smtpUser,
    smtpPass,
    mailFrom,
    mailToManager
  };
}

module.exports = {
  validateAndLoadEnv,
  requireEnv,
  optionalEnv,
  parseBool
};

