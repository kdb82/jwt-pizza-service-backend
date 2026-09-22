jest.mock('mysql2/promise', () => ({
  createConnection: jest.fn(),
}));
jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('hashed-password'),
  compare: jest.fn().mockResolvedValue(true),
}));

const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');

const connection = {
  execute: jest.fn().mockResolvedValue([[{ SCHEMA_NAME: 'pizza' }]]),
  query: jest.fn().mockResolvedValue([[]]),
  end: jest.fn(),
};

mysql.createConnection.mockResolvedValue(connection);

const { DB } = require('../database');

beforeAll(async () => {
  await DB.initialized;
});

afterEach(() => {
  jest.restoreAllMocks();
});

function useConnection() {
  const testConnection = {
    execute: jest.fn(),
    query: jest.fn(),
    beginTransaction: jest.fn(),
    commit: jest.fn(),
    rollback: jest.fn(),
    end: jest.fn(),
  };
  jest.spyOn(DB, 'getConnection').mockResolvedValue(testConnection);
  return testConnection;
}

test('getOffset calculates the first row for a page', () => {
  expect(DB.getOffset(3, 10)).toBe(20);
});

test('getTokenSignature extracts the signature from a JWT', () => {
  expect(DB.getTokenSignature('header.payload.signature')).toBe('signature');
});

test('getTokenSignature returns an empty string for an invalid token', () => {
  expect(DB.getTokenSignature('invalid-token')).toBe('');
});

test('query returns rows from the database connection', async () => {
  const testConnection = { execute: jest.fn().mockResolvedValue([[{ id: 1 }], []]) };

  await expect(DB.query(testConnection, 'SELECT * FROM menu', [])).resolves.toEqual([{ id: 1 }]);
  expect(testConnection.execute).toHaveBeenCalledWith('SELECT * FROM menu', []);
});

test('getID returns a matching row ID', async () => {
  const testConnection = { execute: jest.fn().mockResolvedValue([[{ id: 7 }], []]) };

  await expect(DB.getID(testConnection, 'name', 'Downtown', 'store')).resolves.toBe(7);
});

test('getID rejects when no matching row exists', async () => {
  const testConnection = { execute: jest.fn().mockResolvedValue([[], []]) };

  await expect(DB.getID(testConnection, 'name', 'Missing', 'store')).rejects.toThrow('No ID found');
});

test('getMenu returns menu rows and closes the connection', async () => {
  const testConnection = useConnection();
  const menu = [{ id: 1, title: 'Veggie' }];
  jest.spyOn(DB, 'query').mockResolvedValue(menu);

  await expect(DB.getMenu()).resolves.toEqual(menu);
  expect(testConnection.end).toHaveBeenCalled();
});

test('addMenuItem inserts and returns an item with its ID', async () => {
  const testConnection = useConnection();
  const item = { title: 'Veggie', description: 'Fresh', image: 'veggie.png', price: 0.01 };
  const query = jest.spyOn(DB, 'query').mockResolvedValue({ insertId: 4 });

  await expect(DB.addMenuItem(item)).resolves.toEqual({ ...item, id: 4 });
  expect(query).toHaveBeenCalledWith(testConnection, expect.stringContaining('INSERT INTO menu'), ['Veggie', 'Fresh', 'veggie.png', 0.01]);
  expect(testConnection.end).toHaveBeenCalled();
});

test('addUser hashes the password and adds a diner role', async () => {
  const testConnection = useConnection();
  const user = { name: 'Diner', email: 'diner@test.com', password: 'secret', roles: [{ role: 'diner' }] };
  const query = jest.spyOn(DB, 'query').mockResolvedValueOnce({ insertId: 5 }).mockResolvedValueOnce({});

  await expect(DB.addUser(user)).resolves.toEqual({ ...user, id: 5, password: undefined });
  expect(bcrypt.hash).toHaveBeenCalledWith('secret', 10);
  expect(query).toHaveBeenLastCalledWith(testConnection, expect.stringContaining('INSERT INTO userRole'), [5, 'diner', 0]);
  expect(testConnection.end).toHaveBeenCalled();
});

test('addUser resolves a franchise ID for a franchisee role', async () => {
  const testConnection = useConnection();
  const user = { name: 'Owner', email: 'owner@test.com', password: 'secret', roles: [{ role: 'franchisee', object: 'Pizza Place' }] };
  jest.spyOn(DB, 'query').mockResolvedValueOnce({ insertId: 6 }).mockResolvedValueOnce({});
  const getID = jest.spyOn(DB, 'getID').mockResolvedValue(9);

  await DB.addUser(user);

  expect(getID).toHaveBeenCalledWith(testConnection, 'name', 'Pizza Place', 'franchise');
  expect(DB.query).toHaveBeenLastCalledWith(testConnection, expect.stringContaining('INSERT INTO userRole'), [6, 'franchisee', 9]);
});

test('getUser returns roles without the password', async () => {
  const testConnection = useConnection();
  const query = jest
    .spyOn(DB, 'query')
    .mockResolvedValueOnce([{ id: 5, name: 'Diner', email: 'diner@test.com', password: 'hash' }])
    .mockResolvedValueOnce([{ role: 'diner', objectId: 0 }]);

  const user = await DB.getUser('diner@test.com', 'secret');

  expect(bcrypt.compare).toHaveBeenCalledWith('secret', 'hash');
  expect(user).toEqual({ id: 5, name: 'Diner', email: 'diner@test.com', password: undefined, roles: [{ role: 'diner', objectId: undefined }] });
  expect(query).toHaveBeenCalledTimes(2);
  expect(testConnection.end).toHaveBeenCalled();
});

test('getUser rejects unknown users', async () => {
  const testConnection = useConnection();
  jest.spyOn(DB, 'query').mockResolvedValue([]);

  await expect(DB.getUser('missing@test.com', 'secret')).rejects.toMatchObject({ message: 'unknown user', statusCode: 404 });
  expect(testConnection.end).toHaveBeenCalled();
});

test('updateUser writes changed fields and returns the refreshed user', async () => {
  const testConnection = useConnection();
  const query = jest.spyOn(DB, 'query').mockResolvedValue({});
  const updatedUser = { id: 5, name: 'Updated', email: 'updated@test.com', roles: [{ role: 'diner' }] };
  jest.spyOn(DB, 'getUser').mockResolvedValue(updatedUser);

  await expect(DB.updateUser(5, 'Updated', 'updated@test.com', 'new-secret')).resolves.toEqual(updatedUser);
  expect(query).toHaveBeenCalledWith(testConnection, expect.stringContaining("password='hashed-password', email='updated@test.com', name='Updated'"));
  expect(DB.getUser).toHaveBeenCalledWith('updated@test.com', 'new-secret');
});

test('loginUser stores only the token signature', async () => {
  const testConnection = useConnection();
  const query = jest.spyOn(DB, 'query').mockResolvedValue({});

  await DB.loginUser(5, 'header.payload.signature');

  expect(query).toHaveBeenCalledWith(testConnection, expect.stringContaining('INSERT INTO auth'), ['signature', 5]);
  expect(testConnection.end).toHaveBeenCalled();
});

test('isLoggedIn returns whether the token signature exists', async () => {
  const testConnection = useConnection();
  jest.spyOn(DB, 'query').mockResolvedValue([{ userId: 5 }]);

  await expect(DB.isLoggedIn('header.payload.signature')).resolves.toBe(true);
  expect(DB.query).toHaveBeenCalledWith(testConnection, expect.stringContaining('SELECT userId FROM auth'), ['signature']);
});

test('logoutUser deletes the token signature', async () => {
  const testConnection = useConnection();
  const query = jest.spyOn(DB, 'query').mockResolvedValue({});

  await DB.logoutUser('header.payload.signature');

  expect(query).toHaveBeenCalledWith(testConnection, expect.stringContaining('DELETE FROM auth'), ['signature']);
  expect(testConnection.end).toHaveBeenCalled();
});

test('getOrders attaches items to each order', async () => {
  const testConnection = useConnection();
  const orders = [{ id: 2, franchiseId: 1, storeId: 3 }];
  const items = [{ id: 4, menuId: 1, description: 'Veggie', price: 0.01 }];
  jest.spyOn(DB, 'query').mockResolvedValueOnce(orders).mockResolvedValueOnce(items);

  await expect(DB.getOrders({ id: 5 }, 2)).resolves.toEqual({ dinerId: 5, orders: [{ ...orders[0], items }], page: 2 });
  expect(testConnection.end).toHaveBeenCalled();
});

test('addDinerOrder inserts the order and its items', async () => {
  const testConnection = useConnection();
  const order = { franchiseId: 1, storeId: 3, items: [{ menuId: 4, description: 'Veggie', price: 0.01 }] };
  const query = jest.spyOn(DB, 'query').mockResolvedValueOnce({ insertId: 8 }).mockResolvedValueOnce({});
  jest.spyOn(DB, 'getID').mockResolvedValue(4);

  await expect(DB.addDinerOrder({ id: 5 }, order)).resolves.toEqual({ ...order, id: 8 });
  expect(query).toHaveBeenLastCalledWith(testConnection, expect.stringContaining('INSERT INTO orderItem'), [8, 4, 'Veggie', 0.01]);
});

test('createFranchise adds known admins and franchisee roles', async () => {
  const testConnection = useConnection();
  const franchise = { name: 'Pizza Place', admins: [{ email: 'owner@test.com' }] };
  jest
    .spyOn(DB, 'query')
    .mockResolvedValueOnce([{ id: 6, name: 'Owner' }])
    .mockResolvedValueOnce({ insertId: 9 })
    .mockResolvedValueOnce({});

  await expect(DB.createFranchise(franchise)).resolves.toEqual({
    id: 9,
    name: 'Pizza Place',
    admins: [{ email: 'owner@test.com', id: 6, name: 'Owner' }],
  });
  expect(DB.query).toHaveBeenLastCalledWith(testConnection, expect.stringContaining('INSERT INTO userRole'), [6, 'franchisee', 9]);
});

test('createFranchise rejects an unknown admin', async () => {
  const testConnection = useConnection();
  jest.spyOn(DB, 'query').mockResolvedValue([]);

  await expect(DB.createFranchise({ name: 'Pizza Place', admins: [{ email: 'missing@test.com' }] })).rejects.toMatchObject({
    statusCode: 404,
  });
  expect(testConnection.end).toHaveBeenCalled();
});

test('deleteFranchise commits all deletes', async () => {
  const testConnection = useConnection();
  const query = jest.spyOn(DB, 'query').mockResolvedValue({});

  await DB.deleteFranchise(9);

  expect(testConnection.beginTransaction).toHaveBeenCalled();
  expect(query).toHaveBeenCalledTimes(3);
  expect(testConnection.commit).toHaveBeenCalled();
  expect(testConnection.end).toHaveBeenCalled();
});

test('deleteFranchise rolls back when a delete fails', async () => {
  const testConnection = useConnection();
  jest.spyOn(DB, 'query').mockRejectedValue(new Error('delete failed'));

  await expect(DB.deleteFranchise(9)).rejects.toMatchObject({ message: 'unable to delete franchise', statusCode: 500 });
  expect(testConnection.rollback).toHaveBeenCalled();
  expect(testConnection.commit).not.toHaveBeenCalled();
});

test('getFranchises returns public stores and a more flag', async () => {
  useConnection();
  const franchises = [{ id: 1 }, { id: 2 }, { id: 3 }];
  jest.spyOn(DB, 'query').mockResolvedValueOnce(franchises).mockResolvedValueOnce([{ id: 10 }]).mockResolvedValueOnce([{ id: 20 }]);

  const [result, more] = await DB.getFranchises(undefined, 0, 2, 'Pizza*');

  expect(result).toEqual([{ id: 1, stores: [{ id: 10 }] }, { id: 2, stores: [{ id: 20 }] }]);
  expect(more).toBe(true);
  expect(DB.query).toHaveBeenNthCalledWith(1, expect.anything(), expect.stringContaining('LIMIT 3 OFFSET 0'), ['Pizza%']);
});

test('getUserFranchises returns early when the user has none', async () => {
  const testConnection = useConnection();
  jest.spyOn(DB, 'query').mockResolvedValue([]);

  await expect(DB.getUserFranchises(5)).resolves.toEqual([]);
  expect(testConnection.end).toHaveBeenCalled();
});

test('getFranchise adds admins and stores', async () => {
  const testConnection = useConnection();
  const franchise = { id: 9, name: 'Pizza Place' };
  jest.spyOn(DB, 'query').mockResolvedValueOnce([{ id: 6, name: 'Owner' }]).mockResolvedValueOnce([{ id: 2, name: 'Downtown' }]);

  await expect(DB.getFranchise(franchise)).resolves.toEqual({
    ...franchise,
    admins: [{ id: 6, name: 'Owner' }],
    stores: [{ id: 2, name: 'Downtown' }],
  });
  expect(testConnection.end).toHaveBeenCalled();
});

test('createStore returns the inserted store', async () => {
  const testConnection = useConnection();
  jest.spyOn(DB, 'query').mockResolvedValue({ insertId: 2 });

  await expect(DB.createStore(9, { name: 'Downtown' })).resolves.toEqual({ id: 2, franchiseId: 9, name: 'Downtown' });
  expect(testConnection.end).toHaveBeenCalled();
});

test('deleteStore deletes the matching franchise store', async () => {
  const testConnection = useConnection();
  const query = jest.spyOn(DB, 'query').mockResolvedValue({});

  await DB.deleteStore(9, 2);

  expect(query).toHaveBeenCalledWith(testConnection, expect.stringContaining('DELETE FROM store'), [9, 2]);
  expect(testConnection.end).toHaveBeenCalled();
});

test('_getConnection selects the configured database', async () => {
  const testConnection = { query: jest.fn() };
  mysql.createConnection.mockResolvedValueOnce(testConnection);

  await expect(DB._getConnection()).resolves.toBe(testConnection);
  expect(testConnection.query).toHaveBeenCalledWith('USE pizza');
});

test('checkDatabaseExists reports whether the schema exists', async () => {
  const testConnection = { execute: jest.fn().mockResolvedValue([[], []]) };

  await expect(DB.checkDatabaseExists(testConnection)).resolves.toBe(false);
});