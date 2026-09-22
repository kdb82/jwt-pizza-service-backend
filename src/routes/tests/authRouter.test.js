const request = require('supertest');
const app = require('../../service');

const testUser = { name: 'pizza diner', email: 'reg@test.com', password: 'a' };
let testUserAuthToken;

beforeAll(async () => {
  testUser.email = Math.random().toString(36).substring(2, 12) + '@test.com';
  const registerRes = await request(app).post('/api/auth').send(testUser);
  testUserAuthToken = registerRes.body.token;
  expectValidJwt(testUserAuthToken);
});

test('login', async () => {
  const loginRes = await request(app).put('/api/auth').send(testUser);
  expect(loginRes.status).toBe(200);
  expectValidJwt(loginRes.body.token);

  const expectedUser = { ...testUser, roles: [{ role: 'diner' }] };
  delete expectedUser.password;
  expect(loginRes.body.user).toMatchObject(expectedUser);
});

test('registration requires a name, email, and password', async () => {
  const registerRes = await request(app).post('/api/auth').send({
    name: 'pizza diner',
    email: 'missing-password@test.com',
  });

  expect(registerRes.status).toBe(400);
  expect(registerRes.body).toEqual({ message: 'name, email, and password are required' });
});

test('login rejects an incorrect password', async () => {
  const loginRes = await request(app).put('/api/auth').send({
    email: testUser.email,
    password: 'incorrect-password',
  });

  expect(loginRes.status).toBe(404);
  expect(loginRes.body.message).toBe('unknown user');
});

test('logout rejects an invalid authorization token', async () => {
  const logoutRes = await request(app).delete('/api/auth').set('Authorization', 'Bearer invalid-token');

  expect(logoutRes.status).toBe(401);
  expect(logoutRes.body).toEqual({ message: 'unauthorized' });
});

test('logout succeeds with a valid authorization token', async () => {
  const logoutRes = await request(app).delete('/api/auth').set('Authorization', `Bearer ${testUserAuthToken}`);

  expect(logoutRes.status).toBe(200);
  expect(logoutRes.body).toEqual({ message: 'logout successful' });
});

function expectValidJwt(potentialJwt) {
  expect(potentialJwt).toMatch(/^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/);
}