// One JSON object per line, so pm2 logs stay greppable. Never pass tokens or secrets.

function write(level, message, fields) {
    const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...fields })
    if (level === 'error' || level === 'warn') {
        console.error(line)
    } else {
        console.log(line)
    }
}

export const log = {
    info: (message, fields = {}) => write('info', message, fields),
    warn: (message, fields = {}) => write('warn', message, fields),
    error: (message, fields = {}) => write('error', message, fields),
}
