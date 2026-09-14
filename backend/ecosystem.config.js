// Run from the deployed api/ folder (after `npm ci --production`):
//   pm2 start ecosystem.config.js
//   pm2 save

module.exports = {
  apps: [
    {
      name: 'cmx-sentinel-admin-api',
      script: 'server.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
    },
  ],
};
