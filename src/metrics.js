const os = require('os');
const config = require('./config.js');

const REPORT_PERIOD_MS = 10000;

// A user counts as active if they logged in or made an authenticated request this recently.
const ACTIVE_USER_WINDOW_MS = 5 * 60 * 1000;

// Cumulative request counts by HTTP method, since the service started.
const requestCounts = {};

// Latency totals by endpoint for the current reporting period. Reset after each report.
let latencies = {};

// Cumulative pizza purchase totals, since the service started.
const purchases = { pizzasSold: 0, failures: 0, revenue: 0 };

// Pizza Factory latency totals for the current reporting period. Reset after each report.
let factoryLatency = { totalMs: 0, count: 0 };

// Cumulative login attempts by result, since the service started.
const authAttempts = { success: 0, failure: 0 };

// Last time each user was seen, by user ID.
const activeUsers = new Map();

let reportTimer = null;

// Express middleware that counts every request and times how long it takes.
function requestTracker(req, res, next) {
  const start = performance.now();
  requestCounts[req.method] = (requestCounts[req.method] ?? 0) + 1;

  res.on('finish', () => {
    const endpoint = `${req.method} ${endpointPath(req)}`;
    const entry = (latencies[endpoint] ??= { totalMs: 0, count: 0 });
    entry.totalMs += performance.now() - start;
    entry.count += 1;
  });

  next();
}

// Use the route pattern (e.g. /api/franchise/:franchiseId) instead of the raw URL so
// IDs in the path don't create a separate time series for every franchise or user.
function endpointPath(req) {
  if (!req.route) {
    return 'unknown';
  }
  return `${req.baseUrl}${req.route.path}`;
}

// Call once per order sent to the Pizza Factory. latencyMs is how long the factory took
// to respond, price is the order total, and pizzaCount is the number of pizzas ordered.
function pizzaPurchase(success, latencyMs, price, pizzaCount) {
  factoryLatency.totalMs += latencyMs;
  factoryLatency.count += 1;
  if (success) {
    purchases.pizzasSold += pizzaCount;
    purchases.revenue += price;
  } else {
    purchases.failures += 1;
  }
}

// Call once per login attempt.
function authAttempt(success) {
  authAttempts[success ? 'success' : 'failure'] += 1;
}

// Call when a user logs in or makes an authenticated request.
function userActive(userId) {
  activeUsers.set(userId, Date.now());
}

// Call when a user logs out so they stop counting as active right away.
function userLoggedOut(userId) {
  activeUsers.delete(userId);
}

// One-minute load average divided by core count, as a percentage.
function getCpuUsagePercentage() {
  const cpuUsage = os.loadavg()[0] / os.cpus().length;
  return round2(cpuUsage * 100);
}

function getMemoryUsagePercentage() {
  const totalMemory = os.totalmem();
  const usedMemory = totalMemory - os.freemem();
  return round2((usedMemory / totalMemory) * 100);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

// Collects every metric group into one list for a single push to Grafana.
function buildMetrics() {
  return [...systemMetrics(), ...purchaseMetrics(), ...authMetrics(), ...userMetrics(), ...httpMetrics()];
}

function authMetrics() {
  const points = Object.entries(authAttempts).map(([result, count]) => dataPoint(count, { result }, 'asInt'));
  return [sumMetric('auth_attempts', '1', points)];
}

function userMetrics() {
  const cutoff = Date.now() - ACTIVE_USER_WINDOW_MS;
  for (const [userId, lastSeen] of activeUsers) {
    if (lastSeen < cutoff) {
      activeUsers.delete(userId);
    }
  }
  return [gaugeMetric('active_users', '1', [dataPoint(activeUsers.size, {}, 'asInt')])];
}

function systemMetrics() {
  return [
    gaugeMetric('cpu_usage', '%', [dataPoint(getCpuUsagePercentage(), {}, 'asDouble')]),
    gaugeMetric('memory_usage', '%', [dataPoint(getMemoryUsagePercentage(), {}, 'asDouble')]),
  ];
}

function purchaseMetrics() {
  const metrics = [
    sumMetric('pizzas_sold', '1', [dataPoint(purchases.pizzasSold, {}, 'asInt')]),
    sumMetric('pizza_failures', '1', [dataPoint(purchases.failures, {}, 'asInt')]),
    sumMetric('revenue', '1', [dataPoint(purchases.revenue, {}, 'asDouble')]),
  ];
  if (factoryLatency.count > 0) {
    metrics.push(gaugeMetric('pizza_latency', 'ms', [dataPoint(factoryLatency.totalMs / factoryLatency.count, {}, 'asDouble')]));
  }
  return metrics;
}

function httpMetrics() {
  const metrics = [];
  const requestPoints = Object.entries(requestCounts).map(([method, count]) => dataPoint(count, { method }, 'asInt'));
  if (requestPoints.length > 0) {
    metrics.push(sumMetric('http_requests', '1', requestPoints));
  }
  const latencyPoints = Object.entries(latencies).map(([endpoint, { totalMs, count }]) => dataPoint(totalMs / count, { endpoint }, 'asDouble'));
  if (latencyPoints.length > 0) {
    metrics.push(gaugeMetric('http_request_latency', 'ms', latencyPoints));
  }
  return metrics;
}

// valueType is 'asInt' or 'asDouble'. Keep it fixed per metric so a value like 50.00
// doesn't flip a metric between integer and decimal data points.
function dataPoint(value, attributes, valueType) {
  return {
    [valueType]: value,
    timeUnixNano: Date.now() * 1000000,
    attributes: Object.entries({ ...attributes, source: config.metrics.source }).map(([key, val]) => ({ key, value: { stringValue: String(val) } })),
  };
}

function sumMetric(name, unit, dataPoints) {
  return {
    name,
    unit,
    sum: { dataPoints, aggregationTemporality: 'AGGREGATION_TEMPORALITY_CUMULATIVE', isMonotonic: true },
  };
}

function gaugeMetric(name, unit, dataPoints) {
  return { name, unit, gauge: { dataPoints } };
}

async function sendMetricsToGrafana(metrics) {
  const body = JSON.stringify({ resourceMetrics: [{ scopeMetrics: [{ metrics }] }] });
  try {
    const response = await fetch(config.metrics.endpointUrl, {
      method: 'POST',
      body,
      headers: { Authorization: `Bearer ${config.metrics.accountId}:${config.metrics.apiKey}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      console.error(`Failed to push metrics to Grafana: ${response.status} ${await response.text()}`);
    }
  } catch (error) {
    console.error('Error pushing metrics to Grafana:', error);
  }
}

// Runs on a timer, so it must never throw: an unhandled rejection here would crash the service.
async function report() {
  try {
    const metrics = buildMetrics();
    latencies = {};
    factoryLatency = { totalMs: 0, count: 0 };
    await sendMetricsToGrafana(metrics);
  } catch (error) {
    console.error('Error sending metrics', error);
  }
}

// Starts sending metrics to Grafana on a timer. Called from index.js only, so tests that
// load service.js never push data to Grafana.
function startReporting(periodMs = REPORT_PERIOD_MS) {
  if (reportTimer || !config.metrics?.endpointUrl) {
    return;
  }
  reportTimer = setInterval(report, periodMs);
  reportTimer.unref();
}

function stopReporting() {
  clearInterval(reportTimer);
  reportTimer = null;
}

module.exports = { requestTracker, pizzaPurchase, authAttempt, userActive, userLoggedOut, startReporting, stopReporting, buildMetrics, report };
