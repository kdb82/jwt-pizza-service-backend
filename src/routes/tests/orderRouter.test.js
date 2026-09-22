const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../service');
const config = require('../../config');
const { DB } = require('../../database/database');

let diner;
let dinerAuthToken;

beforeAll(async () => {
  await DB.initialized;
  const registerRes = await request(app)
    .post('/api/auth')
    .send({
      name: 'order route diner',
      email: `${Math.random().toString(36).substring(2, 12)}@test.com`,
      password: 'a',
    });
  diner = registerRes.body.user;
  dinerAuthToken = registerRes.body.token;
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('get menu returns a list without authentication', async () => {
  const menuRes = await request(app).get('/api/order/menu');

  expect(menuRes.status).toBe(200);
  expect(Array.isArray(menuRes.body)).toBe(true);
});

test('menu update requires authentication', async () => {
  const menuRes = await request(app).put('/api/order/menu').send({
    title: 'Test Pizza',
    description: 'Created by a test',
    image: 'test.png',
    price: 0.01,
  });

  expect(menuRes.status).toBe(401);
  expect(menuRes.body).toEqual({ message: 'unauthorized' });
});

test('diner cannot add a menu item', async () => {
  const menuRes = await request(app)
    .put('/api/order/menu')
    .set('Authorization', `Bearer ${dinerAuthToken}`)
    .send({
      title: 'Test Pizza',
      description: 'Created by a test',
      image: 'test.png',
      price: 0.01,
    });

  expect(menuRes.status).toBe(403);
  expect(menuRes.body.message).toBe('unable to add menu item');
});

test('admin can add a menu item', async () => {
  const admin = { id: 1, name: 'admin', email: 'admin@test.com', roles: [{ role: 'admin' }] };
  const adminToken = jwt.sign(admin, config.jwtSecret);
  const menuItem = { id: 1, title: 'Test Pizza', description: 'Created by a test', image: 'test.png', price: 0.01 };
  jest.spyOn(DB, 'isLoggedIn').mockResolvedValue(true);
  const addMenuItem = jest.spyOn(DB, 'addMenuItem').mockResolvedValue(menuItem);
  jest.spyOn(DB, 'getMenu').mockResolvedValue([menuItem]);

  const menuRes = await request(app).put('/api/order/menu').set('Authorization', `Bearer ${adminToken}`).send(menuItem);

  expect(menuRes.status).toBe(200);
  expect(menuRes.body).toEqual([menuItem]);
  expect(addMenuItem).toHaveBeenCalledWith(menuItem);
});

test('authenticated diner can get their orders', async () => {
  const orders = { dinerId: diner.id, orders: [], page: 1 };
  const getOrders = jest.spyOn(DB, 'getOrders').mockResolvedValue(orders);

  const ordersRes = await request(app).get('/api/order').set('Authorization', `Bearer ${dinerAuthToken}`);

  expect(ordersRes.status).toBe(200);
  expect(ordersRes.body).toEqual(orders);
  expect(getOrders).toHaveBeenCalledWith(expect.objectContaining({ id: diner.id }), undefined);
});

test('create order returns the order and factory result', async () => {
  const orderRequest = { franchiseId: 1, storeId: 1, items: [{ menuId: 1, description: 'Test Pizza', price: 0.01 }] };
  const savedOrder = { ...orderRequest, id: 1 };
  jest.spyOn(DB, 'addDinerOrder').mockResolvedValue(savedOrder);
  jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    json: jest.fn().mockResolvedValue({ reportUrl: 'https://example.com/report', jwt: 'factory-token' }),
  });

  const orderRes = await request(app).post('/api/order').set('Authorization', `Bearer ${dinerAuthToken}`).send(orderRequest);

  expect(orderRes.status).toBe(200);
  expect(orderRes.body).toEqual({ order: savedOrder, followLinkToEndChaos: 'https://example.com/report', jwt: 'factory-token' });
});

test('create order reports a factory failure', async () => {
  const orderRequest = { franchiseId: 1, storeId: 1, items: [{ menuId: 1, description: 'Test Pizza', price: 0.01 }] };
  jest.spyOn(DB, 'addDinerOrder').mockResolvedValue({ ...orderRequest, id: 2 });
  jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: false,
    json: jest.fn().mockResolvedValue({ reportUrl: 'https://example.com/failure' }),
  });

  const orderRes = await request(app).post('/api/order').set('Authorization', `Bearer ${dinerAuthToken}`).send(orderRequest);

  expect(orderRes.status).toBe(500);
  expect(orderRes.body).toEqual({ message: 'Failed to fulfill order at factory', followLinkToEndChaos: 'https://example.com/failure' });
});