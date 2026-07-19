module.exports = {
  apps: [
    {
      name: 'wanodeproxy',
      script: 'index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        // Path to the JSON config file (optional; defaults to ./config.json)
        WA_CONFIG: 'config.json',

        // --- Upstream proxy (optional) ---
        // Easiest: set one URL to enable and configure the upstream proxy.
        //   WA_UPSTREAM_PROXY: 'socks5://user:pass@127.0.0.1:1080',
        //   WA_UPSTREAM_PROXY: 'http://127.0.0.1:8080',
        //
        // Or leave everything to config.json and remove these lines.
      },
    },
  ],
};
