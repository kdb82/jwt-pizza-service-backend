const request = require('supertest');
const app = require('../../service');
const { DB } = require('../../database/database');

let testUser;
let testUserAuthToken;

beforeAll(async () => {
  await DB.initialized;
  const registerRes = await request(app)
    .post('/api/auth')
    .send({
      name: `user route diner ${Math.random().toString(36).substring(2, 12)}`,
      email: `${Math.random().toString(36).substring(2, 12)}@test.com`,
      password: 'a',
    });
  testUser = registerRes.body.user;
  testUserAuthToken = registerRes.body.token;
});

test('protected routes reject requests without an authorization token', async () => {
  const userRes = await request(app).get('/api/user/me');

  expect(userRes.status).toBe(401);
  expect(userRes.body).toEqual({ message: 'unauthorized' });
});

test('get authenticated user with a valid token', async () => {
  const userRes = await request(app).get('/api/user/me').set('Authorization', `Bearer ${testUserAuthToken}`);

  expect(userRes.status).toBe(200);
  expect(userRes.body).toMatchObject(testUser);
});

test('authenticated user can update their own account', async () => {
  const updateRes = await request(app)
    .put(`/api/user/${testUser.id}`)
    .set('Authorization', `Bearer ${testUserAuthToken}`)
    .send({ name: `updated ${testUser.name}`, email: testUser.email, password: 'a' });

  expect(updateRes.status).toBe(200);
  expect(updateRes.body.user).toMatchObject({ ...testUser, name: `updated ${testUser.name}` });
  expect(updateRes.body.token).toMatch(/^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/);
});

test('diner cannot update another user', async () => {
  const updateRes = await request(app)
    .put(`/api/user/${testUser.id + 1}`)
    .set('Authorization', `Bearer ${testUserAuthToken}`)
    .send({ name: 'unauthorized update' });

  expect(updateRes.status).toBe(403);
  expect(updateRes.body).toEqual({ message: 'unauthorized' });
});

test('authenticated delete returns the current not implemented response', async () => {
  const deleteRes = await request(app)
    .delete(`/api/user/${testUser.id}`)
    .set('Authorization', `Bearer ${testUserAuthToken}`);

  expect(deleteRes.status).toBe(200);
  expect(deleteRes.body).toEqual({ message: 'not implemented' });
});

test('list users unauthorized', async () => {
  const listUsersRes = await request(app).get('/api/user');

  expect(listUsersRes.status).toBe(401);
});

test('list users', async () => {
  const listRes = await request(app)
    .get('/api/user')
    .query({ name: `updated ${testUser.name}` })
    .set('Authorization', `Bearer ${testUserAuthToken}`);

  expect(listRes.status).toBe(200);
  expect(listRes.body).toEqual({ users: [{ ...testUser, name: `updated ${testUser.name}` }], more: false });
});