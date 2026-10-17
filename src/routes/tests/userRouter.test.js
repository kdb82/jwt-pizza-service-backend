const request = require('supertest');
const app = require('../../service');
const { DB } = require('../../database/database');
const { setAuth } = require('../authRouter');

let testUser;
let testUserAuthToken;
let adminAuthToken;

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

  const adminUser = await DB.addUser({
    name: `user route admin ${Math.random().toString(36).substring(2, 12)}`,
    email: `${Math.random().toString(36).substring(2, 12)}@test.com`,
    password: 'a',
    roles: [{ role: 'admin' }],
  });
  adminAuthToken = await setAuth(adminUser);
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

test('delete user rejects requests without an authorization token', async () => {
  const deleteRes = await request(app).delete(`/api/user/${testUser.id}`);

  expect(deleteRes.status).toBe(401);
});

test('authenticated user can delete their own account', async () => {
  const user = await registerTestUser();
  const deleteRes = await request(app)
    .delete(`/api/user/${user.id}`)
    .set('Authorization', `Bearer ${user.token}`);

  expect(deleteRes.status).toBe(200);
  expect(deleteRes.body).toEqual({ message: 'user deleted' });
});

test('diner cannot delete another user', async () => {
  const deleteRes = await request(app)
    .delete(`/api/user/${testUser.id + 1}`)
    .set('Authorization', `Bearer ${testUserAuthToken}`);

  expect(deleteRes.status).toBe(403);
  expect(deleteRes.body).toEqual({ message: 'unauthorized' });
});

test('admin can delete another user', async () => {
  const user = await registerTestUser();
  const deleteRes = await request(app)
    .delete(`/api/user/${user.id}`)
    .set('Authorization', `Bearer ${adminAuthToken}`);

  expect(deleteRes.status).toBe(200);
  expect(deleteRes.body).toEqual({ message: 'user deleted' });
});

test('list users unauthorized', async () => {
  const listUsersRes = await request(app).get('/api/user');

  expect(listUsersRes.status).toBe(401);
});

test('diner cannot list users', async () => {
  const listUsersRes = await request(app).get('/api/user').set('Authorization', `Bearer ${testUserAuthToken}`);

  expect(listUsersRes.status).toBe(403);
  expect(listUsersRes.body).toEqual({ message: 'unauthorized' });
});

test('list users', async () => {
  const listRes = await request(app)
    .get('/api/user')
    .query({ name: `updated ${testUser.name}` })
    .set('Authorization', `Bearer ${adminAuthToken}`);

  expect(listRes.status).toBe(200);
  expect(listRes.body).toEqual({ users: [{ ...testUser, name: `updated ${testUser.name}` }], more: false });
});

async function registerTestUser() {
  const registerRes = await request(app)
    .post('/api/auth')
    .send({
      name: `delete user ${Math.random().toString(36).substring(2, 12)}`,
      email: `${Math.random().toString(36).substring(2, 12)}@test.com`,
      password: 'a',
    });

  return { ...registerRes.body.user, token: registerRes.body.token };
}