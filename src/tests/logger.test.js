const logger = require('../logger');
const config = require('../config');
const express = require('express');
const request = require('supertest');

const originalNodeEnv = process.env.NODE_ENV;
beforeEach(() => { process.env.NODE_ENV = 'development'; });
afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
  jest.restoreAllMocks();
});

test('sanitizes nested secrets and token-like strings', () => {
  const clean = logger.sanitize({
    password: 'secret',
    nested: { token: 'abc', email: 'diner@example.com', note: 'Bearer private-token', detail: 'password=another-secret' },
    items: [{ apiKey: 'glc_private', jwt: 'header.payload.signature' }],
  });
  expect(JSON.stringify(clean)).not.toMatch(/secret|private|example.com|header.payload.signature/);
  expect(clean.nested.note).toBe('Bearer [REDACTED]');
  expect(clean.nested.detail).toBe('password=[REDACTED]');
});

test('sends sanitized Loki JSON using Basic authentication', async () => {
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true });
  await logger.log('info', 'http', { method: 'POST', reqBody: { password: 'hidden' } });
  const [url, options] = fetchMock.mock.calls[0];
  const body = JSON.parse(options.body);
  expect(url).toBe(config.logging.endpointUrl);
  expect(options.headers.Authorization).toMatch(/^Basic /);
  expect(body.streams[0].stream).toMatchObject({ component: config.logging.source, type: 'http' });
  expect(body.streams[0].values[0][0]).toMatch(/^\d+$/);
  expect(body.streams[0].values[0][1]).not.toContain('hidden');
});

test('database logger preserves query structure but not SQL literals', async () => {
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true });
  await logger.dbLogger("SELECT * FROM user WHERE email='diner@example.com'");
  const line = JSON.parse(fetchMock.mock.calls[0][1].body).streams[0].values[0][1];
  expect(line).toContain('SELECT * FROM user WHERE email=');
  expect(line).not.toContain('diner@example.com');
});

test('factory logger removes user email and response JWT', async () => {
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true });
  await logger.factoryLogger({ diner: { email: 'diner@example.com' }, order: { id: 1 } }, { jwt: 'factory-secret' }, 200);
  const line = JSON.parse(JSON.parse(fetchMock.mock.calls[0][1].body).streams[0].values[0][1]);
  expect(line.reqBody.order).toEqual({ id: 1 });
  expect(line.reqBody.diner.email).toBe('[REDACTED]');
  expect(line.resBody.jwt).toBe('[REDACTED]');
  expect(JSON.stringify(line)).not.toMatch(/example.com|factory-secret/);
});

test('factory failures retain bodies and describe the error', async () => {
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true });
  await logger.factoryLogger({ order: { id: 1 } }, { message: 'Factory unavailable' }, 503);
  const stream = JSON.parse(fetchMock.mock.calls[0][1].body).streams[0];
  const line = JSON.parse(stream.values[0][1]);
  expect(stream.stream.level).toBe('error');
  expect(line).toMatchObject({ name: 'FactoryError', message: 'Factory unavailable', reqBody: { order: { id: 1 } }, resBody: { message: 'Factory unavailable' } });

  await logger.factoryLogger({ order: { id: 2 } }, { error: 'Connection lost' }, 500, new TypeError('Connection lost'));
  const thrownLine = JSON.parse(JSON.parse(fetchMock.mock.calls[1][1].body).streams[0].values[0][1]);
  expect(thrownLine).toMatchObject({ name: 'TypeError', message: 'Connection lost', reqBody: { order: { id: 2 } }, resBody: { error: 'Connection lost' } });
});

test('error logs retain the sanitized request body', async () => {
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true });
  const app = express();
  app.use(express.json());
  app.use(logger.httpLogger);
  app.post('/broken', (req, res, next) => next(new Error('Order failed')));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const responseBody = { message: err.message, stack: err.stack };
    res.locals.logError = err;
    void logger.errorLogger(err, responseBody);
    res.status(500).json(responseBody);
  });

  await request(app).post('/broken').send({ item: 'Veggie', password: 'private' });

  const records = fetchMock.mock.calls.map(([, options]) => {
    const stream = JSON.parse(options.body).streams[0];
    return { type: stream.stream.type, line: JSON.parse(stream.values[0][1]) };
  });
  for (const type of ['unhandledError', 'http']) {
    expect(records.find((record) => record.type === type).line.reqBody).toEqual({ item: 'Veggie', password: '[REDACTED]' });
    expect(records.find((record) => record.type === type).line.resBody).toEqual({ message: 'Order failed', stack: '[REDACTED]' });
    expect(records.find((record) => record.type === type).line).toMatchObject({ name: 'Error', message: 'Order failed' });
  }
});

test('HTTP logs always include both body fields for bodyless and failed requests', async () => {
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true });
  const app = express();
  app.use(logger.httpLogger);
  app.use(express.json());
  app.get('/plain', (req, res) => res.end('plain response'));
  app.get('/missing', (req, res) => res.status(404).json({ message: 'not found' }));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.locals.logError = err;
    res.status(400).json({ message: 'invalid JSON' });
  });

  await request(app).get('/plain');
  await request(app).get('/missing');
  await request(app).post('/plain').set('Content-Type', 'application/json').send('{broken');

  const lines = fetchMock.mock.calls.map(([, options]) => {
    const stream = JSON.parse(options.body).streams[0];
    return JSON.parse(stream.values[0][1]);
  });
  expect(lines.find((line) => line.statusCode === 200)).toMatchObject({ reqBody: {}, resBody: 'plain response' });
  expect(lines.find((line) => line.statusCode === 404)).toMatchObject({ reqBody: {}, resBody: { message: 'not found' }, name: 'HttpError', message: 'not found' });
  expect(lines.find((line) => line.statusCode === 400)).toMatchObject({ reqBody: null, resBody: { message: 'invalid JSON' }, name: 'SyntaxError' });
});

test('HTTP logger records status, identity and sanitized bodies after authentication', async () => {
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true });
  const app = express();
  app.use(express.json());
  app.use(logger.httpLogger);
  app.use((req, res, next) => {
    req.user = { id: 7, name: 'Diner', email: 'diner@example.com' };
    next();
  });
  app.post('/hello', (req, res) => res.status(201).json({ hello: req.body.name, token: 'secret' }));

  await request(app).post('/hello').set('Authorization', 'Bearer private-token').send({ name: 'Diner', password: 'private' });

  const line = JSON.parse(JSON.parse(fetchMock.mock.calls[0][1].body).streams[0].values[0][1]);
  expect(line).toMatchObject({ method: 'POST', path: '/hello', statusCode: 201, authorized: true, user: { id: 7, name: 'Diner' } });
  expect(line.reqBody.password).toBe('[REDACTED]');
  expect(line.resBody.token).toBe('[REDACTED]');
  expect(JSON.stringify(line)).not.toMatch(/private|diner@example.com/);
});

test('SQL and factory logs include the authenticated request user', async () => {
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true });
  const app = express();
  app.use(logger.httpLogger);
  app.use((req, res, next) => {
    req.user = { id: 7, name: 'Diner' };
    next();
  });
  app.get('/order', async (req, res) => {
    await logger.dbLogger('SELECT * FROM menu');
    await logger.factoryLogger({ order: { id: 1 } }, { reportUrl: 'https://example.com' }, 200);
    res.sendStatus(204);
  });

  await request(app).get('/order');

  const records = fetchMock.mock.calls.map(([, options]) => {
    const stream = JSON.parse(options.body).streams[0];
    return { type: stream.stream.type, line: JSON.parse(stream.values[0][1]) };
  });
  expect(records.find((record) => record.type === 'db').line.user).toEqual({ id: 7, name: 'Diner' });
  expect(records.find((record) => record.type === 'factory').line.user).toEqual({ id: 7, name: 'Diner' });
});
