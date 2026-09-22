const { StatusCodeError } = require('../endpointHelper');

test('StatusCodeError stores its message and status code', () => {
  const error = new StatusCodeError('unauthorized', 401);

  expect(error.message).toBe('unauthorized');
  expect(error.statusCode).toBe(401);
});