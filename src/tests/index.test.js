const mockListen = jest.fn();

jest.mock('../service.js', () => ({ listen: mockListen }));

test('server listens on port 3000 by default', () => {
  const originalArgv = process.argv;
  process.argv = ['node', 'src/index.js'];

  try {
    require('../index.js');
  } finally {
    process.argv = originalArgv;
  }

  expect(mockListen).toHaveBeenCalledWith(3000, expect.any(Function));
});

test('server listens on the command-line port', () => {
  const originalArgv = process.argv;
  process.argv = ['node', 'src/index.js', '4000'];
  jest.resetModules();
  mockListen.mockClear();

  try {
    require('../index.js');
  } finally {
    process.argv = originalArgv;
  }

  expect(mockListen).toHaveBeenCalledWith('4000', expect.any(Function));
});

test('server logs the port after it starts listening', () => {
  const originalArgv = process.argv;
  process.argv = ['node', 'src/index.js', '4000'];
  jest.resetModules();
  mockListen.mockImplementationOnce((port, callback) => callback());
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});

  try {
    require('../index.js');
  } finally {
    process.argv = originalArgv;
  }

  expect(log).toHaveBeenCalledWith('Server started on port 4000');
  log.mockRestore();
});