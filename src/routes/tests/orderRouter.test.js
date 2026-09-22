const request = require('supertest');
const app = require('../../service');
const { DB } = require('../../database/database');

beforeAll(async () => {
  await DB.initialized;
});

test('get menu returns a list without authentication', async () => {
  const menuRes = await request(app).get('/api/order/menu');

  expect(menuRes.status).toBe(200);
  expect(Array.isArray(menuRes.body)).toBe(true);
});