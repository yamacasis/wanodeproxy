'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  // WhatsApp chat traffic (the Noise-encrypted client<->chatd stream).
  chat: {
    listenPorts: [443, 5222, 8443, 8199, 8222, 8080, 80],
    target: { host: 'g.whatsapp.net', port: 443 },
  },
  // WhatsApp media traffic (uploads/downloads).
  media: {
    listenPorts: [587, 7777, 8901],
    target: { host: 'mmg.whatsapp.net', port: 443 },
  },
  // Optional upstream proxy. When enabled, ALL outbound connections to
  // WhatsApp's servers are tunneled through it.
  upstreamProxy: {
    enabled: false,
    type: 'socks5', // "socks5" | "http"
    host: '127.0.0.1',
    port: 1080,
    username: null,
    password: null,
  },
  bindAddress: '0.0.0.0',
  connectTimeoutMs: 15000,
  // When true, logs every stage of each connection (client accepted, upstream
  // connect attempt, proxy handshake steps, socket close/error) instead of
  // just the summary lines. Useful for diagnosing "client connects then
  // disconnects" issues.
  debug: false,
};

function deepMerge(base, override) {
  if (Array.isArray(override)) return override.slice();
  if (override && typeof override === 'object' && base && typeof base === 'object' && !Array.isArray(base)) {
    const out = { ...base };
    for (const key of Object.keys(override)) {
      out[key] = deepMerge(base[key], override[key]);
    }
    return out;
  }
  return override === undefined ? base : override;
}

function loadFromFile(configPath) {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) return {};
  const raw = fs.readFileSync(resolved, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse config file "${resolved}": ${err.message}`);
  }
}

// Environment overrides make it easy to enable the upstream proxy without
// editing a file (useful in containers).
function applyEnvOverrides(cfg) {
  const env = process.env;
  if (env.WA_BIND_ADDRESS) cfg.bindAddress = env.WA_BIND_ADDRESS;
  if (env.WA_DEBUG) cfg.debug = env.WA_DEBUG === 'true';

  if (env.WA_UPSTREAM_PROXY || env.WA_UPSTREAM_ENABLED === 'true') {
    cfg.upstreamProxy = cfg.upstreamProxy || {};
    cfg.upstreamProxy.enabled = true;
  }
  // WA_UPSTREAM_PROXY accepts a full URL, e.g. socks5://user:pass@host:1080
  if (env.WA_UPSTREAM_PROXY) {
    try {
      const u = new URL(env.WA_UPSTREAM_PROXY);
      const scheme = u.protocol.replace(':', '').toLowerCase();
      cfg.upstreamProxy.type = scheme.startsWith('http') ? 'http' : 'socks5';
      cfg.upstreamProxy.host = u.hostname;
      cfg.upstreamProxy.port = Number(u.port) || (scheme.startsWith('http') ? 8080 : 1080);
      cfg.upstreamProxy.username = u.username ? decodeURIComponent(u.username) : null;
      cfg.upstreamProxy.password = u.password ? decodeURIComponent(u.password) : null;
    } catch (err) {
      throw new Error(`Invalid WA_UPSTREAM_PROXY URL: ${err.message}`);
    }
  }
  if (env.WA_UPSTREAM_TYPE) cfg.upstreamProxy.type = env.WA_UPSTREAM_TYPE;
  if (env.WA_UPSTREAM_HOST) cfg.upstreamProxy.host = env.WA_UPSTREAM_HOST;
  if (env.WA_UPSTREAM_PORT) cfg.upstreamProxy.port = Number(env.WA_UPSTREAM_PORT);
  if (env.WA_UPSTREAM_USERNAME) cfg.upstreamProxy.username = env.WA_UPSTREAM_USERNAME;
  if (env.WA_UPSTREAM_PASSWORD) cfg.upstreamProxy.password = env.WA_UPSTREAM_PASSWORD;

  return cfg;
}

function validate(cfg) {
  const p = cfg.upstreamProxy;
  if (p && p.enabled) {
    const type = String(p.type || '').toLowerCase();
    if (!['socks5', 'socks', 'http', 'https', 'connect'].includes(type)) {
      throw new Error(`config.upstreamProxy.type must be "socks5" or "http", got "${p.type}"`);
    }
    if (!p.host) throw new Error('config.upstreamProxy.host is required when the upstream proxy is enabled');
    if (!p.port) throw new Error('config.upstreamProxy.port is required when the upstream proxy is enabled');
  }
  for (const section of ['chat', 'media']) {
    const s = cfg[section];
    if (!s || !Array.isArray(s.listenPorts) || !s.target || !s.target.host || !s.target.port) {
      throw new Error(`config.${section} is misconfigured (needs listenPorts[] and target.host/target.port)`);
    }
  }
  return cfg;
}

/**
 * Load configuration by merging defaults, an optional JSON file, and
 * environment variable overrides (in that order of increasing precedence).
 * @param {string} [configPath] path to a JSON config file
 */
function loadConfig(configPath = process.env.WA_CONFIG || 'config.json') {
  const fileCfg = loadFromFile(configPath);
  let cfg = deepMerge(DEFAULT_CONFIG, fileCfg);
  cfg = applyEnvOverrides(cfg);
  return validate(cfg);
}

module.exports = { loadConfig, DEFAULT_CONFIG };
