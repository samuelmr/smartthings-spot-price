// pm2 process definition: `pm2 start ecosystem.config.cjs` (first time),
// `pm2 reload ecosystem.config.cjs` after deploys
module.exports = {
    apps: [
        {
            name: 'Spot price connector',
            script: 'spike/server.js',
            node_args: '--env-file-if-exists=.env',
            env: {
                PORT: 7768,
            },
        },
    ],
}
