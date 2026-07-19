'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { connectThroughUpstream } = require('../src/upstream');
const { loadConfig } = require('../src/config');

// A tiny in-process SOCKS5 server that accepts one CONNECT and then echoes.
function startFakeSocks5({ requireAuth = false } = {}) {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let stage = 'greeting';
      let buf = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (stage === 'greeting') {
          const n = buf[1];
          if (buf.length < 2 + n) return;
          buf = buf.subarray(2 + n);
          if (requireAuth) {
            sock.write(Buffer.from([0x05, 0x02]));
            stage = 'auth';
          } else {
            sock.write(Buffer.from([0x05, 0x00]));
            stage = 'request';
          }
        }
        if (stage === 'auth') {
          if (buf.length < 2) return;
          const ulen = buf[1];
          if (buf.length < 2 + ulen + 1) return;
          const plen = buf[2 + ulen];
          if (buf.length < 2 + ulen + 1 + plen) return;
          buf = buf.subarray(2 + ulen + 1 + plen);
          sock.write(Buffer.from([0x01, 0x00]));
          stage = 'request';
        }
        if (stage === 'request') {
          if (buf.length < 5) return;
          const dlen = buf[4];
          const need = 5 + dlen + 2;
          if (buf.length < need) return;
          buf = buf.subarray(need);
          // Success reply with bogus bound addr 0.0.0.0:0
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          stage = 'tunnel';
          // Echo anything else back.
          sock.on('data', (d) => sock.write(d));
          if (buf.length) sock.write(buf);
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('SOCKS5 without auth tunnels and forwards payload', async () => {
  const server = await startFakeSocks5();
  const { port } = server.address();
  const sock = await connectThroughUpstream('example.com', 443, {
    enabled: true, type: 'socks5', host: '127.0.0.1', port,
  });
  const got = await new Promise((resolve) => {
    sock.once('data', (d) => resolve(d.toString()));
    sock.write('hello');
  });
  assert.strictEqual(got, 'hello');
  sock.destroy();
  server.close();
});

test('SOCKS5 with username/password auth succeeds', async () => {
  const server = await startFakeSocks5({ requireAuth: true });
  const { port } = server.address();
  const sock = await connectThroughUpstream('example.com', 443, {
    enabled: true, type: 'socks5', host: '127.0.0.1', port,
    username: 'u', password: 'p',
  });
  const got = await new Promise((resolve) => {
    sock.once('data', (d) => resolve(d.toString()));
    sock.write('world');
  });
  assert.strictEqual(got, 'world');
  sock.destroy();
  server.close();
});

test('direct connect (no proxy) works', async () => {
  const echo = net.createServer((s) => s.pipe(s));
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  const { port } = echo.address();
  const sock = await connectThroughUpstream('127.0.0.1', port, null);
  const got = await new Promise((resolve) => {
    sock.once('data', (d) => resolve(d.toString()));
    sock.write('direct');
  });
  assert.strictEqual(got, 'direct');
  sock.destroy();
  echo.close();
});

test('config loads defaults and validates', () => {
  const cfg = loadConfig('/nonexistent/config.json');
  assert.strictEqual(cfg.upstreamProxy.enabled, false);
  assert.ok(cfg.chat.listenPorts.includes(443));
  assert.strictEqual(cfg.chat.target.host, 'g.whatsapp.net');
});
