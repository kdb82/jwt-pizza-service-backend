const app = require('./service.js');
const metrics = require('./metrics.js');
const logger = require('./logger.js');

let fatalErrorLogged = false;
async function logFatalError(error) {
  if (fatalErrorLogged) return;
  fatalErrorLogged = true;
  try {
    await logger.errorLogger(error instanceof Error ? error : new Error('Unhandled rejection'));
  } finally {
    process.exit(1);
  }
}
process.on('uncaughtException', logFatalError);
process.on('unhandledRejection', logFatalError);

const port = process.argv[2] || 3000;
app.listen(port, () => {
  console.log(`Server started on port ${port}`);
  metrics.startReporting();
});
