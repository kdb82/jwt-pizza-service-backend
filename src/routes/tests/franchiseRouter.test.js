const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../service');
const config = require('../../config');
const { DB } = require('../../database/database');

const diner = { id: 10, name: 'diner', email: 'diner@test.com', roles: [{ role: 'diner' }] };
const admin = { id: 1, name: 'admin', email: 'admin@test.com', roles: [{ role: 'admin' }] };
const franchisee = { id: 20, name: 'franchisee', email: 'franchisee@test.com', roles: [{ role: 'franchisee', objectId: 1 }] };

beforeAll(async () => {
  await DB.initialized;
});

afterEach(() => {
  jest.restoreAllMocks();
});

function authorizationFor(user) {
  jest.spyOn(DB, 'isLoggedIn').mockResolvedValue(true);
  return `Bearer ${jwt.sign(user, config.jwtSecret)}`;
}

test('get franchises returns a public paginated list', async () => {
  const franchises = [{ id: 1, name: 'Test Franchise', stores: [] }];
  const getFranchises = jest.spyOn(DB, 'getFranchises').mockResolvedValue([franchises, true]);

  const franchiseRes = await request(app).get('/api/franchise?page=2&limit=5&name=Test*');

  expect(franchiseRes.status).toBe(200);
  expect(franchiseRes.body).toEqual({ franchises, more: true });
  expect(getFranchises).toHaveBeenCalledWith(undefined, '2', '5', 'Test*');
});

test('get user franchises requires authentication', async () => {
  const franchiseRes = await request(app).get('/api/franchise/10');

  expect(franchiseRes.status).toBe(401);
  expect(franchiseRes.body).toEqual({ message: 'unauthorized' });
});

test('user can get their own franchises', async () => {
  const franchises = [{ id: 1, name: 'Test Franchise' }];
  const getUserFranchises = jest.spyOn(DB, 'getUserFranchises').mockResolvedValue(franchises);

  const franchiseRes = await request(app).get('/api/franchise/10').set('Authorization', authorizationFor(diner));

  expect(franchiseRes.status).toBe(200);
  expect(franchiseRes.body).toEqual(franchises);
  expect(getUserFranchises).toHaveBeenCalledWith(10);
});

test('diner cannot get another user franchises', async () => {
  const getUserFranchises = jest.spyOn(DB, 'getUserFranchises');

  const franchiseRes = await request(app).get('/api/franchise/11').set('Authorization', authorizationFor(diner));

  expect(franchiseRes.status).toBe(200);
  expect(franchiseRes.body).toEqual([]);
  expect(getUserFranchises).not.toHaveBeenCalled();
});

test('diner cannot create a franchise', async () => {
  const franchiseRes = await request(app)
    .post('/api/franchise')
    .set('Authorization', authorizationFor(diner))
    .send({ name: 'Test Franchise', admins: [] });

  expect(franchiseRes.status).toBe(403);
  expect(franchiseRes.body.message).toBe('unable to create a franchise');
});

test('admin can create a franchise', async () => {
  const franchise = { id: 1, name: 'Test Franchise', admins: [] };
  const createFranchise = jest.spyOn(DB, 'createFranchise').mockResolvedValue(franchise);

  const franchiseRes = await request(app)
    .post('/api/franchise')
    .set('Authorization', authorizationFor(admin))
    .send({ name: franchise.name, admins: [] });

  expect(franchiseRes.status).toBe(200);
  expect(franchiseRes.body).toEqual(franchise);
  expect(createFranchise).toHaveBeenCalledWith({ name: franchise.name, admins: [] });
});

test('delete franchise calls the database and confirms deletion', async () => {
  const deleteFranchise = jest.spyOn(DB, 'deleteFranchise').mockResolvedValue();

  const franchiseRes = await request(app).delete('/api/franchise/3');

  expect(franchiseRes.status).toBe(200);
  expect(franchiseRes.body).toEqual({ message: 'franchise deleted' });
  expect(deleteFranchise).toHaveBeenCalledWith(3);
});

test('cannot create a store for a missing franchise', async () => {
  jest.spyOn(DB, 'getFranchise').mockResolvedValue(undefined);

  const storeRes = await request(app)
    .post('/api/franchise/99/store')
    .set('Authorization', authorizationFor(admin))
    .send({ name: 'Test Store' });

  expect(storeRes.status).toBe(403);
  expect(storeRes.body.message).toBe('unable to create a store');
});

test('admin can create a store', async () => {
  const franchise = { id: 1, name: 'Test Franchise', admins: [] };
  const store = { id: 2, franchiseId: 1, name: 'Test Store' };
  jest.spyOn(DB, 'getFranchise').mockResolvedValue(franchise);
  const createStore = jest.spyOn(DB, 'createStore').mockResolvedValue(store);

  const storeRes = await request(app)
    .post('/api/franchise/1/store')
    .set('Authorization', authorizationFor(admin))
    .send({ name: store.name });

  expect(storeRes.status).toBe(200);
  expect(storeRes.body).toEqual(store);
  expect(createStore).toHaveBeenCalledWith(1, { name: store.name });
});

test('franchise admin can delete a store', async () => {
  const franchise = { id: 1, name: 'Test Franchise', admins: [{ id: franchisee.id }] };
  jest.spyOn(DB, 'getFranchise').mockResolvedValue(franchise);
  const deleteStore = jest.spyOn(DB, 'deleteStore').mockResolvedValue();

  const storeRes = await request(app)
    .delete('/api/franchise/1/store/2')
    .set('Authorization', authorizationFor(franchisee));

  expect(storeRes.status).toBe(200);
  expect(storeRes.body).toEqual({ message: 'store deleted' });
  expect(deleteStore).toHaveBeenCalledWith(1, 2);
});

test('diner cannot delete a store', async () => {
  jest.spyOn(DB, 'getFranchise').mockResolvedValue({ id: 1, admins: [{ id: franchisee.id }] });
  const deleteStore = jest.spyOn(DB, 'deleteStore');

  const storeRes = await request(app).delete('/api/franchise/1/store/2').set('Authorization', authorizationFor(diner));

  expect(storeRes.status).toBe(403);
  expect(storeRes.body.message).toBe('unable to delete a store');
  expect(deleteStore).not.toHaveBeenCalled();
});