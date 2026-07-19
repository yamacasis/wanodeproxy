'use strict';

const net = require('net');
const { connectThroughUpstream } = require('./upstream');

let connectionCounter = 0;

/**
 * Create a TCP relay server for one WhatsApp traffic class (chat or media).
 *
 * Incoming client sockets are piped to an outbound connection to `target`.
 * That outbound connection is opened either directly or, when configured,
 * through the upstream proxy.
 *
 * @param {object} opts
 * @param {{host:string, port:number}} opts.target  WhatsApp backend
 * @param {object|null} opts.upstreamProxy           upstream proxy config
 * @param {number} opts.connectTimeoutMs
 * @param {string} opts.label                        "chat" | "media" (logging)
 * @param {function} [opts.log]
 * @returns {net.Server}
 */
function createRelayServer(opts) {
  const { target, upstreamProxy, connectTimeoutMs, label, log = console.log } = opts;

  const server = net.createServer((client) => {
    const id = ++connectionCounter;
    const peer = `${client.remoteAddress}:${client.remotePort}`;
    client.setNoDelay(true);
    // Pause the client until the upstream leg is ready so no bytes are dropped.
    client.pause();

    connectThroughUpstream(target.host, target.port, upstreamProxy, connectTimeoutMs)
      .then((upstream) => {
        upstream.setNoDelay(true);
        pipeBidirectional(client, upstream);
        client.resume();
      })
      .catch((err) => {
        log(`[${label}#${id}] upstream connect failed for ${peer}: ${err.message}`);
        client.destroy();
      });

    client.on('error', () => {});
  });

  server.on('error', (err) => {
    log(`[${label}] server error: ${err.message}`);
  });

  return server;
}

function pipeBidirectional(a, b) {
  a.pipe(b);
  b.pipe(a);

  const cleanup = () => {
    a.destroy();
    b.destroy();
  };
  a.on('error', cleanup);
  b.on('error', cleanup);
  a.on('close', () => b.destroy());
  b.on('close', () => a.destroy());
}

/**
 * Start all relay servers described by the config.
 * @returns {Promise<net.Server[]>}
 */
function startAll(cfg, log = console.log) {
  const servers = [];
  const tasks = [];

  const sections = [
    { key: 'chat', ...cfg.chat },
    { key: 'media', ...cfg.media },
  ];

  for (const section of sections) {
    for (const port of section.listenPorts) {
      const server = createRelayServer({
        target: section.target,
        upstreamProxy: cfg.upstreamProxy,
        connectTimeoutMs: cfg.connectTimeoutMs,
        label: section.key,
        log,
      });
      servers.push(server);
      tasks.push(
        new Promise((resolve) => {
          server.listen(port, cfg.bindAddress, () => {
            log(
              `[${section.key}] listening on ${cfg.bindAddress}:${port} -> ` +
                `${section.target.host}:${section.target.port}`
            );
            resolve();
          });
          server.on('error', (err) => {
            log(`[${section.key}] failed to bind port ${port}: ${err.message}`);
            resolve();
          });
        })
      );
    }
  }

  return Promise.all(tasks).then(() => servers);
}

module.exports = { createRelayServer, startAll };
