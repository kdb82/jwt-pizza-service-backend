const express = require('express');
const request = require('supertest');

jest.mock('../config.js', () => ({
  metrics: { source: 'test-source', endpointUrl: 'https://grafana.test/otlp/v1/metrics', accountId: '123', apiKey: 'test-key' },
}));

let metrics;
let app;

beforeEach(() => {
  jest.resetModules();
  metrics = require('../metrics.js');

  app = express();
  app.use(metrics.requestTracker);
  const router = express.Router();
  router.get('/item/:id', (req, res) => res.json({ id: req.params.id }));
  router.put('/item', (req, res) => res.json({}));
  app.use('/api', router);
  app.use('*', (req, res) => res.status(404).json({}));

  global.fetch = jest.fn().mockResolvedValue({ ok: true });
});

afterEach(() => {
  metrics.stopReporting();
  jest.restoreAllMocks();
  jest.useRealTimers();
  delete global.fetch;
});

function findMetric(built, name) {
  return built.find((m) => m.name === name);
}

function attr(point, key) {
  return point.attributes.find((a) => a.key === key)?.value.stringValue;
}

test('counts requests by method', async () => {
  await request(app).get('/api/item/1');
  await request(app).get('/api/item/2');
  await request(app).put('/api/item');

  const requests = findMetric(metrics.buildMetrics(), 'http_requests');
  const counts = Object.fromEntries(requests.sum.dataPoints.map((p) => [attr(p, 'method'), p.asInt]));

  expect(counts).toEqual({ GET: 2, PUT: 1 });
  expect(requests.sum.isMonotonic).toBe(true);
  expect(requests.sum.aggregationTemporality).toBe('AGGREGATION_TEMPORALITY_CUMULATIVE');
});

test('records latency by route pattern, not raw URL', async () => {
  await request(app).get('/api/item/1');
  await request(app).get('/api/item/2');
  await request(app).get('/nowhere');

  const latency = findMetric(metrics.buildMetrics(), 'http_request_latency');
  const endpoints = latency.gauge.dataPoints.map((p) => attr(p, 'endpoint'));

  // Unmatched URLs share one label so bad URLs can't each create a new time series.
  expect(endpoints).toEqual(['GET /api/item/:id', 'GET unknown']);
  expect(latency.unit).toBe('ms');
});

test('every data point carries the configured source', async () => {
  await request(app).get('/api/item/1');

  for (const metric of metrics.buildMetrics()) {
    const points = (metric.sum ?? metric.gauge).dataPoints;
    points.forEach((p) => expect(attr(p, 'source')).toBe('test-source'));
  }
});

test('sends system, purchase, auth, and user metrics when there has been no traffic', () => {
  expect(metrics.buildMetrics().map((m) => m.name)).toEqual(['cpu_usage', 'memory_usage', 'pizzas_sold', 'pizza_failures', 'revenue', 'auth_attempts', 'active_users']);
});

test('reports CPU as load average per core and memory as percent used', () => {
  const os = require('os');
  jest.spyOn(os, 'loadavg').mockReturnValue([2, 0, 0]);
  jest.spyOn(os, 'cpus').mockReturnValue(new Array(8).fill({}));
  jest.spyOn(os, 'totalmem').mockReturnValue(1000);
  jest.spyOn(os, 'freemem').mockReturnValue(333);

  const built = metrics.buildMetrics();
  const cpu = findMetric(built, 'cpu_usage');
  const memory = findMetric(built, 'memory_usage');

  expect(cpu.unit).toBe('%');
  expect(cpu.gauge.dataPoints[0].asDouble).toBe(25);
  expect(memory.gauge.dataPoints[0].asDouble).toBe(66.7);
});

test('pizzaPurchase totals pizzas and revenue on success and counts failed orders', () => {
  metrics.pizzaPurchase(true, 100, 0.05, 2);
  metrics.pizzaPurchase(true, 300, 0.01, 1);
  metrics.pizzaPurchase(false, 200, 0, 22);

  const built = metrics.buildMetrics();
  expect(findMetric(built, 'pizzas_sold').sum.dataPoints[0].asInt).toBe(3);
  expect(findMetric(built, 'pizza_failures').sum.dataPoints[0].asInt).toBe(1);
  expect(findMetric(built, 'revenue').sum.dataPoints[0].asDouble).toBeCloseTo(0.06);
  expect(findMetric(built, 'pizza_latency').gauge.dataPoints[0].asDouble).toBe(200);
  expect(findMetric(built, 'pizza_latency').unit).toBe('ms');
});

test('pizza latency starts over each report but purchase totals do not', async () => {
  metrics.pizzaPurchase(true, 100, 0.05, 2);

  await metrics.report();
  const built = metrics.buildMetrics();

  expect(findMetric(built, 'pizza_latency')).toBeUndefined();
  expect(findMetric(built, 'pizzas_sold').sum.dataPoints[0].asInt).toBe(2);
});

test('authAttempt counts successful and failed logins separately', () => {
  metrics.authAttempt(true);
  metrics.authAttempt(false);
  metrics.authAttempt(false);

  const points = findMetric(metrics.buildMetrics(), 'auth_attempts').sum.dataPoints;
  const counts = Object.fromEntries(points.map((p) => [attr(p, 'result'), p.asInt]));

  expect(counts).toEqual({ success: 1, failure: 2 });
});

test('active users counts each user once and drops them on logout', () => {
  metrics.userActive(1);
  metrics.userActive(1);
  metrics.userActive(2);
  metrics.userLoggedOut(2);

  const activeUsers = findMetric(metrics.buildMetrics(), 'active_users');
  expect(activeUsers.gauge.dataPoints[0].asInt).toBe(1);
});

test('active users drops users not seen for five minutes', () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
  metrics.userActive(1);
  now.mockReturnValue(1_000_000 + 4 * 60 * 1000);
  metrics.userActive(2);

  now.mockReturnValue(1_000_000 + 5 * 60 * 1000 + 1);
  const activeUsers = findMetric(metrics.buildMetrics(), 'active_users');

  expect(activeUsers.gauge.dataPoints[0].asInt).toBe(1);
});

test('report sends metrics to Grafana and resets latency', async () => {
  await request(app).get('/api/item/1');

  await metrics.report();

  expect(global.fetch).toHaveBeenCalledTimes(1);
  const [url, options] = global.fetch.mock.calls[0];
  expect(url).toBe('https://grafana.test/otlp/v1/metrics');
  expect(options.headers.Authorization).toBe('Bearer 123:test-key');
  const sent = JSON.parse(options.body).resourceMetrics[0].scopeMetrics[0].metrics;
  expect(sent.map((m) => m.name)).toEqual(['cpu_usage', 'memory_usage', 'pizzas_sold', 'pizza_failures', 'revenue', 'auth_attempts', 'active_users', 'http_requests', 'http_request_latency']);

  // Request counts are cumulative; latency starts over each period.
  expect(metrics.buildMetrics().map((m) => m.name)).toEqual(['cpu_usage', 'memory_usage', 'pizzas_sold', 'pizza_failures', 'revenue', 'auth_attempts', 'active_users', 'http_requests']);
});

test('report logs when Grafana rejects the metrics', async () => {
  global.fetch.mockResolvedValue({ ok: false, status: 401, text: async () => 'bad key' });
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  await request(app).get('/api/item/1');

  await metrics.report();

  expect(error).toHaveBeenCalledWith('Failed to push metrics to Grafana: 401 bad key');
});

test('report logs when Grafana cannot be reached', async () => {
  global.fetch.mockRejectedValue(new Error('network down'));
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  await request(app).get('/api/item/1');

  await metrics.report();

  expect(error).toHaveBeenCalledWith('Error pushing metrics to Grafana:', expect.any(Error));
});

test('report logs instead of throwing when building metrics fails', async () => {
  jest.spyOn(require('os'), 'cpus').mockImplementation(() => {
    throw new Error('no cpu info');
  });
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});

  await expect(metrics.report()).resolves.toBeUndefined();

  expect(error).toHaveBeenCalledWith('Error sending metrics', expect.any(Error));
  expect(global.fetch).not.toHaveBeenCalled();
});

test('startReporting sends on a timer and only starts once', async () => {
  await request(app).get('/api/item/1');
  jest.useFakeTimers();

  metrics.startReporting(1000);
  metrics.startReporting(1000);
  await jest.advanceTimersByTimeAsync(1000);

  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test('startReporting does nothing without a Grafana endpoint', async () => {
  jest.resetModules();
  jest.doMock('../config.js', () => ({ metrics: { source: 'test-source', endpointUrl: '' } }));
  const unconfigured = require('../metrics.js');
  jest.useFakeTimers();

  unconfigured.startReporting(1000);
  await jest.advanceTimersByTimeAsync(5000);

  expect(global.fetch).not.toHaveBeenCalled();
});
