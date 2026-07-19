#!/usr/bin/env node
/**
 * JSWAProxy - WhatsApp proxy, single file, zero dependencies. Node 16+
 *
 * Usage:
 *   node waproxy.js [path/to/config.json]
 *
 * Env overrides:
 *   WAPROXY_CONFIG=/etc/waproxy/config.json node waproxy.js
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;

// ---------- Load config ----------
const DEFAULTS = {
  listeners: [
    { port: 8080, mode: 'auto' },
    { port: 8443, mode: 'tls' },
    { port: 5222, mode: 'chat' },
  ],
  bind: '0.0.0.0',
  chatUpstream: { host: 'g.whatsapp.net', port: 5222 },
  defaultTlsPort: 443,
  allowedDomains: ['whatsapp.net', 'whatsapp.com', 'wa.me', 'fbcdn.net', 'facebook.com'],
  timeout: 120000,
  handshakeTimeout: 15000,
  maxConns: 5000,
  verbose: true,
  statsInterval: 60000,
};

const configPath = process.argv[2]
  || process.env.WAPROXY_CONFIG
  || path.join(__dirname, 'config.json');

let CONFIG;
try {
  const raw = fs.readFileSync(configPath, 'utf8');
  CONFIG = { ...DEFAULTS, ...JSON.parse(raw) };
  console.log(`Config loaded: ${configPath}`);
} catch (e) {
  console.warn(`Could not read config (${configPath}): ${e.message}`);
  console.warn('Falling back to built-in defaults.');
  CONFIG = { ...DEFAULTS };
}

if (!Array.isArray(CONFIG.listeners) || CONFIG.listeners.length === 0) {
  console.error('config.listeners must be a non-empty array. Exiting.');
  process.exit(1);
}

// Build domain matcher from config
const domainRe = new RegExp(
  '(^|\\.)(' + CONFIG.allowedDomains.map(d => d.replace(/\./g, '\\.')).join('|') + ')$',
  'i'
);

// ---------- State ----------
let activeConns = 0;
let totalConns = 0;
const dnsCache = new Map(); // host -> { ip, expires }

const log = (...a) => CONFIG.verbose && console.log(new Date().toISOString(), ...a);

// ---------- SNI parser ----------
function parseSNI(buf) {
  try {
    if (buf.length < 43 || buf[0] !== 0x16) return null;

    let p = 43; // record hdr(5) + handshake hdr(4) + version(2) + random(32)

    const sidLen = buf[p];
    p += 1 + sidLen;
    if (p + 2 > buf.length) return null;

    const csLen = buf.readUInt16BE(p);
    p += 2 + csLen;
    if (p + 1 > buf.length) return null;

    const cmLen = buf[p];
    p += 1 + cmLen;
    if (p + 2 > buf.length) return null;

    const extTotal = buf.readUInt16BE(p);
    p += 2;
    const end = Math.min(p + extTotal, buf.length);

    while (p + 4 <= end) {
      const type = buf.readUInt16BE(p);
      const len = buf.readUInt16BE(p + 2);
      p += 4;
      if (type === 0x0000 && p + 5 <= end) {
        let q = p + 2;
        const nameType = buf[q]; q += 1;
        const nameLen = buf.readUInt16BE(q); q += 2;
        if (nameType === 0 && q + nameLen <= buf.length) {
          return buf.toString('utf8', q, q + nameLen);
        }
      }
      p += len;
    }
  } catch (_) {}
  return null;
}

function isTlsHandshake(buf) {
  return buf.length >= 3 && buf[0] === 0x16 && buf[1] === 0x03;
}

function isAllowedHost(host) {
  return !!host && domainRe.test(host);
}

// ---------- DNS with cache ----------
async function resolveHost(host) {
  const now = Date.now();
  const hit = dnsCache.get(host);
  if (hit && hit.expires > now) return hit.ip;
  try {
    const { address } = await dns.lookup(host, { family: 4 });
    dnsCache.set(host, { ip: address, expires: now + 300000 }); // 5 min
    return address;
  } catch (_) {
    return null;
  }
}

// ---------- Piping ----------
function pipeSockets(a, b, onDone) {
  let closed = false;
  const shut = () => {
    if (closed) return;
    closed = true;
    a.destroy();
    b.destroy();
    onDone();
  };
  a.on('error', shut).on('close', shut).setTimeout(CONFIG.timeout, shut);
  b.on('error', shut).on('close', shut).setTimeout(CONFIG.timeout, shut);
  a.pipe(b);
  b.pipe(a);
}

// ---------- Connection handling ----------
function handleConnection(client, listener) {
  if (activeConns >= CONFIG.maxConns) {
    client.destroy();
    return;
  }

  activeConns++;
  const id = ++totalConns;
  const peer = client.remoteAddress;
  let released = false;
  const release = () => { if (!released) { released = true; activeConns--; } };

  client.setNoDelay(true);
  client.on('error', () => { client.destroy(); release(); });

  // chat mode: no sniffing, straight relay
  if (listener.mode === 'chat') {
    connectUpstream(client, CONFIG.chatUpstream.host, CONFIG.chatUpstream.port, id, peer, null, release);
    return;
  }

  // auto / tls: buffer first bytes and sniff
  let buffered = Buffer.alloc(0);
  let decided = false;

  const handshakeTimer = setTimeout(() => {
    if (!decided) { client.destroy(); release(); }
  }, CONFIG.handshakeTimeout);

  const onData = (chunk) => {
    if (decided) return;
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length < 6) return;

    // Wait for the full ClientHello record if it's TLS and still incomplete
    if (isTlsHandshake(buffered)) {
      const recLen = buffered.readUInt16BE(3);
      if (buffered.length < recLen + 5 && buffered.length < 4096) return;
    }

    decided = true;
    clearTimeout(handshakeTimer);
    client.removeListener('data', onData);
    client.pause();

    const sni = parseSNI(buffered);

    if (sni) {
      if (!isAllowedHost(sni)) {
        log(`[${id}] reject SNI: ${sni}`);
        client.destroy();
        release();
        return;
      }
      connectUpstream(client, sni, CONFIG.defaultTlsPort, id, peer, buffered, release);
      return;
    }

    if (listener.mode === 'tls') {
      log(`[${id}] no SNI on tls-mode port ${listener.port} - drop`);
      client.destroy();
      release();
      return;
    }

    // auto mode, no SNI -> chat upstream
    connectUpstream(client, CONFIG.chatUpstream.host, CONFIG.chatUpstream.port, id, peer, buffered, release);
  };

  client.on('data', onData);
}

async function connectUpstream(client, host, port, id, peer, prebuffer, release) {
  const ip = await resolveHost(host);
  if (!ip) {
    log(`[${id}] DNS fail: ${host}`);
    client.destroy();
    release();
    return;
  }

  const upstream = net.connect({ host: ip, port }, () => {
    log(`[${id}] ${peer} -> ${host}:${port} (${ip})`);
    upstream.setNoDelay(true);
    if (prebuffer && prebuffer.length) upstream.write(prebuffer);
    client.resume();
    pipeSockets(client, upstream, release);
  });

  upstream.on('error', (e) => {
    log(`[${id}] upstream error ${host}:${port} - ${e.message}`);
    client.destroy();
    upstream.destroy();
    release();
  });
}

// ---------- Start ----------
const servers = [];

for (const l of CONFIG.listeners) {
  const listener = { port: l.port, mode: l.mode || 'auto' };

  if (!['auto', 'tls', 'chat'].includes(listener.mode)) {
    console.error(`Invalid mode "${listener.mode}" on port ${listener.port} - skipping`);
    continue;
  }

  const server = net.createServer((sock) => handleConnection(sock, listener));

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`Port ${listener.port} in use - skipped`);
    else if (e.code === 'EACCES') console.error(`Port ${listener.port} denied - needs privileges`);
    else console.error(`Port ${listener.port}: ${e.message}`);
  });

  server.listen(listener.port, CONFIG.bind, () => {
    console.log(`  listening ${CONFIG.bind}:${listener.port}  [${listener.mode}]`);
  });

  servers.push(server);
}

if (CONFIG.statsInterval > 0) {
  setInterval(() => log(`active=${activeConns} total=${totalConns}`), CONFIG.statsInterval);
}

// ---------- Shutdown ----------
function shutdown() {
  console.log('\nShutting down...');
  servers.forEach(s => s.close());
  setTimeout(() => process.exit(0), 1000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (e) => console.error('uncaught:', e.message));

console.log(`
========================================
  JSWAProxy
  Config: ${configPath}
  Set in WhatsApp:
    Settings > Storage and Data > Proxy
    Host:       <your-server-ip-or-domain>
    Chat port:  ${CONFIG.listeners.find(l => l.mode === 'chat')?.port || 'n/a'}
    Media port: ${CONFIG.listeners.find(l => l.mode !== 'chat')?.port || 'n/a'}
========================================
`);