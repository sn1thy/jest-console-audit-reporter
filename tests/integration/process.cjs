const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');

// File-backed output also works in sandboxes that prohibit subprocess pipe sockets.
exports.runJest = (dir, args) => new Promise((resolve, reject) => {
  const log = path.join(dir, 'fixture-output.log');
  const fd = fs.openSync(log, 'w');
  let child;
  try {
    child = spawn(process.execPath, [require.resolve('jest/bin/jest'), ...args], {
      cwd: dir, stdio: ['ignore', fd, fd],
    });
  } finally { fs.closeSync(fd); }
  let unexpectedBeforeDone = false;
  const observe = () => {
    const text = fs.readFileSync(log, 'utf8');
    if (text.includes('UNEXPECTED_LIVE') && !text.includes('TEST_FINISHED')) unexpectedBeforeDone = true;
    return text;
  };
  const poll = setInterval(observe, 10);
  const timeout = setTimeout(() => {
    child.kill('SIGKILL');
    clearInterval(poll);
    reject(Error('Jest fixture timed out\n' + observe()));
  }, 20000);
  child.on('error', e => { clearInterval(poll); clearTimeout(timeout); reject(e); });
  child.on('close', code => {
    clearInterval(poll); clearTimeout(timeout);
    resolve({code, text: observe(), unexpectedBeforeDone});
  });
});
