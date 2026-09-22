const { asyncHandler, StatusCodeError } = require('../endpointHelper');

test('StatusCodeError stores its message and status code', () => {
  const error = new StatusCodeError('unauthorized', 401);

  expect(error.message).toBe('unauthorized');
  expect(error.statusCode).toBe(401);
});

test('asyncHandler calls the wrapped handler with the Express arguments', async () => {
  const handler = jest.fn();
  const request = {};
  const response = {};
  const next = jest.fn();

  await asyncHandler(handler)(request, response, next);

  expect(handler).toHaveBeenCalledWith(request, response, next);
  expect(handler).toHaveBeenCalledTimes(1);
});

test('asyncHandler passes rejected errors to next', async () => {
  const error = new Error('database failed');
  const handler = jest.fn().mockRejectedValue(error);
  const next = jest.fn();

  await asyncHandler(handler)({}, {}, next);

  expect(next).toHaveBeenCalledWith(error);
  expect(next).toHaveBeenCalledTimes(1);
});