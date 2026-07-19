# wanodeproxy

WhatsApp proxy server in Node.js — with **optional upstream proxy support**.

It listens on the standard WhatsApp proxy ports and relays traffic to
WhatsApp's servers (`g.whatsapp.net` for chat, `mmg.whatsapp.net` for media).
WhatsApp traffic is already end-to-end encrypted at the application layer
(Noise Protocol), so this proxy is a pure TCP relay — it never inspects or
decrypts content.

The key feature: if an **upstream proxy** is defined in the config, all outbound
connections to WhatsApp's servers are tunneled through it. Both **SOCKS5**
(with optional username/password auth) and **HTTP CONNECT** proxies are
supported. No external npm dependencies.

```
WhatsApp client ──▶ wanodeproxy ──▶ [upstream SOCKS5/HTTP proxy] ──▶ WhatsApp servers
                                    (only if enabled in config)
```

## Requirements

- Node.js >= 18

## Quick start

```bash
cp config.example.json config.json
# edit config.json as needed
npm start
```

Binding to ports below 1024 (80, 443, 587) usually requires elevated
privileges. On Linux you can grant them without running as root:

```bash
sudo setcap 'cap_net_bind_service=+ep' "$(command -v node)"
```

## Configuration

Config is loaded from `config.json` by default (override with the `WA_CONFIG`
env var). See `config.example.json`.

### Enabling the upstream proxy

This is the part that makes wanodeproxy reach WhatsApp *through* another proxy.
Set it in `config.json`:

```json
{
  "upstreamProxy": {
    "enabled": true,
    "type": "socks5",
    "host": "127.0.0.1",
    "port": 1080,
    "username": null,
    "password": null
  }
}
```

- `type`: `"socks5"` or `"http"`
- `username` / `password`: optional; used for SOCKS5 (RFC 1929) or HTTP Basic
  proxy auth. Leave `null` for no auth.

When `enabled` is `false` (the default), wanodeproxy connects to WhatsApp
directly.

### Environment variable overrides

Handy for containers — no need to edit the file:

| Variable | Description |
| --- | --- |
| `WA_CONFIG` | Path to the JSON config file |
| `WA_BIND_ADDRESS` | Address to bind listeners to |
| `WA_UPSTREAM_PROXY` | Full proxy URL, e.g. `socks5://user:pass@host:1080` or `http://host:8080` — enables the upstream proxy |
| `WA_UPSTREAM_ENABLED` | Set to `true` to enable the upstream proxy |
| `WA_UPSTREAM_TYPE` | `socks5` or `http` |
| `WA_UPSTREAM_HOST` / `WA_UPSTREAM_PORT` | Proxy host / port |
| `WA_UPSTREAM_USERNAME` / `WA_UPSTREAM_PASSWORD` | Proxy credentials |

Example:

```bash
WA_UPSTREAM_PROXY="socks5://user:pass@10.0.0.5:1080" npm start
```

## Ports

Defaults follow WhatsApp's official proxy port list:

- Chat: `443, 5222, 8443, 8199, 8222, 8080, 80` → `g.whatsapp.net:443`
- Media: `587, 7777, 8901` → `mmg.whatsapp.net:443`

Adjust `listenPorts` / `target` per section in the config as needed.

## Using it from WhatsApp

In the WhatsApp app: **Settings → Storage and data → Proxy → Use proxy**, then
enter the public hostname/IP of the machine running wanodeproxy.

## Tests

```bash
npm test
```

Covers the SOCKS5 handshake (with and without auth), direct connect, config
loading, and an end-to-end relay-through-proxy path.

## License

MIT
