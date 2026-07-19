'use strict';

const { loadConfig } = require('./src/config');
const { startAll } = require('./src/relay');

function main() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }

  const up = cfg.upstreamProxy;
  if (up && up.enabled) {
    const auth = up.username ? ' (with auth)' : '';
    console.log(
      `Upstream proxy ENABLED: ${up.type}://${up.host}:${up.port}${auth} ` +
        `— all WhatsApp traffic will be tunneled through it.`
    );
  } else {
    console.log('Upstream proxy disabled — connecting to WhatsApp servers directly.');
  }

  startAll(cfg).then((servers) => {
    console.log(`WhatsApp proxy started with ${servers.length} listener(s).`);
  });

  const shutdown = (signal) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
