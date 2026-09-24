import { spawn } from 'node:child_process'

const api = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, PORT: '3001', NODE_ENV: 'development' },
  stdio: 'inherit',
})
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], {
  stdio: 'inherit',
})

const stop = () => {
  api.kill('SIGTERM')
  vite.kill('SIGTERM')
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
api.on('exit', (code) => { if (code) { vite.kill('SIGTERM'); process.exitCode = code } })
vite.on('exit', (code) => { if (code) { api.kill('SIGTERM'); process.exitCode = code } })
