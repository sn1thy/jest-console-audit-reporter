const path = require('node:path');
const configFile = path.resolve(__dirname, 'console-audit.config.json');
module.exports = {
  testEnvironment: 'jest-console-audit-reporter/environment/node',
  testEnvironmentOptions: { consoleAudit: { configFile } },
  reporters: ['default', ['jest-console-audit-reporter/reporter', { configFile }]],
};
