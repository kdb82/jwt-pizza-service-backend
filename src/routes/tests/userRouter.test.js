const request = require('supertest');
const app = require('../../service');
const { DB } = require('../../database/database');

beforeAll(async () => {
  await DB.initialized;
});

test('protected routes reject requests without an authorization token', async () => {
  const userRes = await request(app).get('/api/user/me');

  expect(userRes.status).toBe(401);
  expect(userRes.body).toEqual({ message: 'unauthorized' });
});