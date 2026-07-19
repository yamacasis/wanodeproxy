'use strict';

const net = require('net');

/**
 * Establish an outbound TCP connection to `destHost:destPort`.
 *
 * When `proxy` is null/undefined or disabled, connects directly. Otherwise the
 * connection is tunneled through the configured upstream proxy so that all
 * traffic to WhatsApp's servers leaves through that proxy.
 *
 * Supported proxy types: "socks5" (RFC 1928 + optional RFC 1929 auth) and
 * "http" (HTTP CONNECT tunneling with optional Basic auth).
 *
 * @param {string} destHost
 * @param {number} destPort
 * @param {object|null} proxy
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<net.Socket>} a connected socket ready to carry traffic
 */
function connectThroughUpstream(destHost, destPort, proxy, timeoutMs = 15000) {
  if (!proxy || proxy.enabled === false) {
    return directConnect(destHost, destPort, timeoutMs);
  }

  const type = String(proxy.type || '').toLowerCase();
  if (type === 'socks5' || type === 'socks') {
    return socks5Connect(destHost, destPort, proxy, timeoutMs);
  }
  if (type === 'http' || type === 'https' || type === 'connect') {
    return httpConnect(destHost, destPort, proxy, timeoutMs);
  }
  return Promise.reject(
    new Error(`Unsupported upstream proxy type: "${proxy.type}" (use "socks5" or "http")`)
  );
}

function directConnect(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    armTimeout(socket, timeoutMs, reject);
    socket.once('connect', () => {
      clearTimeout(socket._connTimer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(socket._connTimer);
      reject(err);
    });
  });
}

function socks5Connect(destHost, destPort, proxy, timeoutMs) {
  return new Promise((resolve, reject) => {
    const host = proxy.host || '127.0.0.1';
    const port = Number(proxy.port) || 1080;
    const useAuth = Boolean(proxy.username);

    const socket = net.connect({ host, port });
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(socket._connTimer);
      socket.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      clearTimeout(socket._connTimer);
      socket.removeListener('data', onData);
      resolve(socket);
    };

    armTimeout(socket, timeoutMs, fail);
    socket.once('error', fail);

    // Handshake state machine driven by a small buffer.
    let stage = 'greeting';
    let buf = Buffer.alloc(0);

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      if (stage === 'greeting') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05) return fail(new Error('SOCKS5: bad version in method reply'));
        const method = buf[1];
        buf = buf.subarray(2);
        if (method === 0x00) {
          stage = 'request';
          sendRequest();
        } else if (method === 0x02) {
          if (!useAuth) return fail(new Error('SOCKS5: server requires auth but none configured'));
          stage = 'auth';
          sendAuth();
        } else if (method === 0xff) {
          return fail(new Error('SOCKS5: no acceptable authentication method'));
        } else {
          return fail(new Error(`SOCKS5: unsupported method 0x${method.toString(16)}`));
        }
        if (buf.length) onData(Buffer.alloc(0)); // reprocess leftover
        return;
      }

      if (stage === 'auth') {
        if (buf.length < 2) return;
        if (buf[1] !== 0x00) return fail(new Error('SOCKS5: authentication failed'));
        buf = buf.subarray(2);
        stage = 'request';
        sendRequest();
        if (buf.length) onData(Buffer.alloc(0));
        return;
      }

      if (stage === 'request') {
        // Reply: VER REP RSV ATYP BND.ADDR BND.PORT
        if (buf.length < 4) return;
        if (buf[0] !== 0x05) return fail(new Error('SOCKS5: bad version in connect reply'));
        const rep = buf[1];
        if (rep !== 0x00) return fail(new Error(`SOCKS5: connect failed (code 0x${rep.toString(16)})`));
        const atyp = buf[3];
        let need = 4;
        if (atyp === 0x01) need += 4 + 2;
        else if (atyp === 0x04) need += 16 + 2;
        else if (atyp === 0x03) {
          if (buf.length < 5) return;
          need += 1 + buf[4] + 2;
        } else {
          return fail(new Error(`SOCKS5: unknown address type 0x${atyp.toString(16)}`));
        }
        if (buf.length < need) return;
        // Success. Anything after the reply is real payload; put it back.
        const leftover = buf.subarray(need);
        socket.removeListener('data', onData);
        if (leftover.length) socket.unshift(leftover);
        return succeed();
      }
    };

    socket.on('data', onData);

    socket.once('connect', () => {
      // Send greeting once the TCP connection to the proxy is up.
      const methods = useAuth ? Buffer.from([0x00, 0x02]) : Buffer.from([0x00]);
      socket.write(Buffer.concat([Buffer.from([0x05, methods.length]), methods]));
    });

    function sendAuth() {
      const user = Buffer.from(String(proxy.username || ''), 'utf8');
      const pass = Buffer.from(String(proxy.password || ''), 'utf8');
      if (user.length > 255 || pass.length > 255) {
        return fail(new Error('SOCKS5: username/password too long'));
      }
      socket.write(
        Buffer.concat([
          Buffer.from([0x01, user.length]),
          user,
          Buffer.from([pass.length]),
          pass,
        ])
      );
    }

    function sendRequest() {
      const hostBuf = Buffer.from(destHost, 'utf8');
      if (hostBuf.length > 255) return fail(new Error('SOCKS5: destination host too long'));
      const req = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
        hostBuf,
        portBuffer(destPort),
      ]);
      socket.write(req);
    }
  });
}

function httpConnect(destHost, destPort, proxy, timeoutMs) {
  return new Promise((resolve, reject) => {
    const host = proxy.host || '127.0.0.1';
    const port = Number(proxy.port) || 8080;

    const socket = net.connect({ host, port });
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(socket._connTimer);
      socket.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    armTimeout(socket, timeoutMs, fail);
    socket.once('error', fail);

    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        if (buf.length > 65536) return fail(new Error('HTTP CONNECT: response headers too large'));
        return;
      }
      const statusLine = buf.subarray(0, buf.indexOf('\r\n')).toString('latin1');
      const match = /^HTTP\/\d\.\d\s+(\d{3})/.exec(statusLine);
      if (!match) return fail(new Error(`HTTP CONNECT: malformed status line: "${statusLine}"`));
      const code = Number(match[1]);
      if (code !== 200) return fail(new Error(`HTTP CONNECT: proxy returned ${statusLine.trim()}`));

      settled = true;
      clearTimeout(socket._connTimer);
      socket.removeListener('data', onData);
      const leftover = buf.subarray(headerEnd + 4);
      if (leftover.length) socket.unshift(leftover);
      resolve(socket);
    };

    socket.on('data', onData);

    socket.once('connect', () => {
      const target = `${destHost}:${destPort}`;
      let req =
        `CONNECT ${target} HTTP/1.1\r\n` +
        `Host: ${target}\r\n` +
        `Proxy-Connection: keep-alive\r\n`;
      if (proxy.username) {
        const creds = `${proxy.username}:${proxy.password || ''}`;
        req += `Proxy-Authorization: Basic ${Buffer.from(creds).toString('base64')}\r\n`;
      }
      req += '\r\n';
      socket.write(req);
    });
  });
}

function portBuffer(port) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(port & 0xffff, 0);
  return b;
}

function armTimeout(socket, timeoutMs, onTimeout) {
  socket._connTimer = setTimeout(() => {
    socket.destroy();
    onTimeout(new Error(`upstream connect timed out after ${timeoutMs}ms`));
  }, timeoutMs);
}

module.exports = { connectThroughUpstream };
