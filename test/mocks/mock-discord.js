// Mock Discord IPC endpoint: speaks the 8-byte-header frame protocol,
// validates the handshake, and journals every frame to mock-discord.log.
const net = require('net');
const fs = require('fs');
const path = require('path');
const SOCK = process.argv[2];
const LOG = process.argv[3];
// A Windows named pipe (\\.\pipe\… / \\?\pipe\…) is not a filesystem path —
// no directory to create, nothing to unlink (the pipe dies with the process).
const isPipe = /^\\\\[.?]\\pipe\\/.test(SOCK);
if (!isPipe) {
  fs.mkdirSync(path.dirname(SOCK), { recursive: true });
  try { fs.unlinkSync(SOCK); } catch (_) {}
}
fs.writeFileSync(LOG, '');
const frame = (op, obj) => {
  const j = Buffer.from(JSON.stringify(obj));
  const h = Buffer.alloc(8);
  h.writeUInt32LE(op, 0); h.writeUInt32LE(j.length, 4);
  return Buffer.concat([h, j]);
};
net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 8) {
      const op = buf.readUInt32LE(0), len = buf.readUInt32LE(4);
      if (buf.length < 8 + len) break;
      const payload = JSON.parse(buf.slice(8, 8 + len).toString());
      buf = buf.slice(8 + len);
      fs.appendFileSync(LOG, JSON.stringify({ op, payload }) + '\n');
      if (op === 0) { // handshake — accept the test ID and the shipped default
        if (payload.v === 1 && ['123456789012345678', '1527236432375189535'].includes(payload.client_id)) {
          sock.write(frame(1, { cmd: 'DISPATCH', evt: 'READY', data: { v: 1 } }));
        } else {
          sock.write(frame(1, { cmd: 'DISPATCH', evt: 'ERROR', data: { code: 4000, message: 'bad client id' } }));
          sock.end();
        }
      } else if (op === 1 && payload.cmd === 'SET_ACTIVITY') {
        // Answer like Discord: an ERROR event for a rejected activity (any
        // large_image containing "reject-me"), else the accepted-command echo.
        const act = payload.args && payload.args.activity;
        const img = act && act.assets && act.assets.large_image;
        if (typeof img === 'string' && img.includes('reject-me')) {
          sock.write(frame(1, { cmd: 'SET_ACTIVITY', evt: 'ERROR', nonce: payload.nonce,
            data: { code: 4000, message: 'Invalid asset: large_image' } }));
        } else {
          sock.write(frame(1, { cmd: 'SET_ACTIVITY', evt: null, nonce: payload.nonce, data: act }));
        }
      }
    }
  });
  sock.on('error', () => {});
}).listen(SOCK, () => console.log('mock discord up at ' + SOCK));
