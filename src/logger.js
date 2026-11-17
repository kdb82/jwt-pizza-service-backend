const { AsyncLocalStorage } = require('node:async_hooks');
const config = require('./config.js');

const requests = new AsyncLocalStorage();
const REDACTED = '[REDACTED]';
const privateKey = /password|passwd|secret|token|jwt|api.?key|authorization|cookie|session|credit.?card|card.?number|cvv|ssn|email|stack/i;

function scrub(value) {
  return value
    .replace(/\b(password|passwd|secret|token|jwt|api.?key|authorization|cookie|session|cvv)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, `$1=${REDACTED}`)
    .replace(/\bBearer\s+\S+/gi, `Bearer ${REDACTED}`)
    .replace(/\bglc_[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, REDACTED);
}

function sanitize(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    try {
      if (/^\s*[{[]/.test(value)) return sanitize(JSON.parse(value), seen);
    } catch {
      // Non-JSON response bodies are still scrubbed as plain text.
    }
    return scrub(value);
  }
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Buffer.isBuffer(value)) return '[Binary body]';
  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, privateKey.test(key) ? REDACTED : sanitize(item, seen)]));
}

function currentUser() {
  const user = requests.getStore()?.req.user;
  return user ? { id: user.id, name: user.name } : undefined;
}

function log(level, type, data) {
  if (process.env.NODE_ENV === 'test') return Promise.resolve();
  const logging = config.logging;
  if (!logging?.endpointUrl || !logging?.accountId || !logging?.apiKey) return Promise.resolve();
  const event = {
    streams: [{
      stream: { component: logging.source, level, type },
      values: [[(BigInt(Date.now()) * 1000000n).toString(), JSON.stringify(sanitize(data))]],
    }],
  };
  const auth = Buffer.from(`${logging.accountId}:${logging.apiKey}`).toString('base64');
  return fetch(logging.endpointUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(5000),
  }).then((response) => {
    if (!response.ok) console.error(`Grafana log push failed (HTTP ${response.status})`);
  }).catch(() => console.error('Grafana log push failed'));
}

function httpLogger(req, res, next) {
  requests.run({ req }, () => {
    let responseBody;
    const send = res.send;
    res.send = function (body) {
      responseBody = body;
      return send.call(this, body);
    };
    res.once('finish', () => {
      const statusCode = res.statusCode;
      void log(statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info', 'http', {
        method: req.method,
        path: req.path,
        statusCode,
        authorized: Boolean(req.headers.authorization),
        user: req.user ? { id: req.user.id, name: req.user.name } : undefined,
        reqBody: req.body,
        resBody: responseBody,
      });
    });
    next();
  });
}

function dbLogger(sql) {
  // Never log bound parameters or literal SQL values (password hashes and emails occur in some queries).
  const query = sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"/g, "'[REDACTED]'");
  return log('info', 'db', { query, user: currentUser() });
}

function factoryLogger(requestBody, responseBody, statusCode) {
  return log(statusCode >= 500 ? 'error' : 'info', 'factory', {
    user: currentUser(), requestBody, responseBody, statusCode,
  });
}

function errorLogger(err) {
  return log('error', 'unhandledError', {
    user: currentUser(), name: err?.name, message: err?.message, statusCode: err?.statusCode,
  });
}

module.exports = { sanitize, log, httpLogger, dbLogger, factoryLogger, errorLogger };
