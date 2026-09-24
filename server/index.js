import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { roster } from './roster.js'
import { storeAt } from './store.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAX_IMAGE_BYTES = 6 * 1024 * 1024
const MAX_BODY_BYTES = 8 * 1024 * 1024 + 1024
const SESSION_MS = 7 * 24 * 60 * 60 * 1000

export function shanghaiDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value)
  const get = (type) => parts.find((part) => part.type === type).value
  return `${get('year')}-${get('month')}-${get('day')}`
}

function validDate(value, today) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value && value <= today
}

function imageType(data) {
  if (data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { mime: 'image/png', ext: 'png' }
  if (data.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return { mime: 'image/jpeg', ext: 'jpg' }
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' }
  return null
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) tooLarge = true
      else chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) return reject(Object.assign(new Error('图片过大'), { status: 413 }))
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(Object.assign(new Error('请求格式不正确'), { status: 400 })) }
    })
    req.on('error', reject)
  })
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function cookie(req, name) {
  return (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1)
}

export function createApp({ dataDir = path.join(ROOT, 'data'), password, now = () => new Date() } = {}) {
  if (!password) throw new Error('请设置 ADMIN_PASSWORD')
  const store = storeAt(dataDir)
  const sessions = new Map()
  const attempts = new Map()
  const passHash = crypto.createHash('sha256').update(password).digest()
  const authorized = (req) => {
    const token = cookie(req, 'daily_admin')
    const expires = sessions.get(token)
    if (!expires) return false
    if (expires <= Date.now()) { sessions.delete(token); return false }
    return true
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'same-origin')
    const url = new URL(req.url, 'http://localhost')
    const today = shanghaiDate(now())
    const date = url.searchParams.get('date') || today

    try {
      if (req.method === 'GET' && url.pathname === '/api/meta') {
        return json(res, 200, { today, roster })
      }
      if (req.method === 'GET' && url.pathname === '/api/my') {
        if (!validDate(date, today)) return json(res, 400, { error: '日期不正确' })
        const personId = url.searchParams.get('personId')
        if (!roster.some((person) => person.id === personId)) return json(res, 400, { error: '请选择姓名' })
        const record = store.latest(date, personId)
        return json(res, 200, { submitted: Boolean(record), uploadedAt: record?.uploadedAt || null })
      }
      if (req.method === 'POST' && url.pathname === '/api/upload') {
        const body = await readJson(req)
        if (!validDate(body.date, today)) return json(res, 400, { error: '日期不正确' })
        if (!roster.some((person) => person.id === body.personId)) return json(res, 400, { error: '请选择姓名' })
        if (typeof body.image !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(body.image)) {
          return json(res, 400, { error: '请选择 PNG、JPG 或 WebP 图片' })
        }
        const bytes = Buffer.from(body.image.slice(body.image.indexOf(',') + 1), 'base64')
        const type = imageType(bytes)
        if (!type || bytes.length === 0) return json(res, 400, { error: '图片格式不正确' })
        if (bytes.length > MAX_IMAGE_BYTES) return json(res, 413, { error: '图片不能超过 6 MB' })
        const record = store.add(body.date, body.personId, bytes, type, now().toISOString())
        if (!record) return json(res, 400, { error: '该日期的名单中没有此人' })
        return json(res, 201, { submitted: true, uploadedAt: record.uploadedAt })
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/login') {
        const ip = req.socket.remoteAddress || 'unknown'
        const prior = attempts.get(ip)
        if (prior && prior.until > Date.now() && prior.count >= 5) return json(res, 429, { error: '尝试次数过多，请稍后再试' })
        const body = await readJson(req)
        const candidate = crypto.createHash('sha256').update(String(body.password || '')).digest()
        if (!crypto.timingSafeEqual(candidate, passHash)) {
          const count = prior && prior.until > Date.now() ? prior.count + 1 : 1
          attempts.set(ip, { count, until: Date.now() + 15 * 60 * 1000 })
          return json(res, 401, { error: '密码不正确' })
        }
        attempts.delete(ip)
        const token = crypto.randomBytes(32).toString('hex')
        sessions.set(token, Date.now() + SESSION_MS)
        const secure = process.env.PUBLIC_HTTPS === '1' ? '; Secure' : ''
        res.setHeader('Set-Cookie', `daily_admin=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`)
        return json(res, 200, { ok: true })
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/status') {
        return authorized(req) ? json(res, 200, { ok: true }) : json(res, 401, { error: '请先登录' })
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/logout') {
        sessions.delete(cookie(req, 'daily_admin'))
        res.setHeader('Set-Cookie', 'daily_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0')
        return json(res, 200, { ok: true })
      }
      if (url.pathname.startsWith('/api/admin/') && !authorized(req)) return json(res, 401, { error: '请先登录' })
      if (req.method === 'GET' && url.pathname === '/api/admin/day') {
        if (!validDate(date, today)) return json(res, 400, { error: '日期不正确' })
        const entry = store.day(date)
        const people = entry.people.map((person) => {
          const record = store.latest(date, person.id)
          return { ...person, submitted: Boolean(record), uploadedAt: record?.uploadedAt || null, imageId: record?.id || null }
        }).sort((a, b) => Number(a.submitted) - Number(b.submitted))
        return json(res, 200, { date, total: people.length, submitted: people.filter((person) => person.submitted).length, people })
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/admin/image/')) {
        const id = url.pathname.slice('/api/admin/image/'.length)
        if (!/^[0-9a-f-]{36}$/.test(id)) return json(res, 404, { error: '图片不存在' })
        const image = store.image(id)
        if (!image || !fs.existsSync(image.filePath)) return json(res, 404, { error: '图片不存在' })
        res.writeHead(200, { 'Content-Type': image.mime, 'Cache-Control': 'private, no-store' })
        return fs.createReadStream(image.filePath).pipe(res)
      }
      if (url.pathname.startsWith('/api/')) return json(res, 404, { error: '接口不存在' })

      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: '不支持的请求' })
      const dist = path.join(ROOT, 'dist')
      const asset = url.pathname.startsWith('/assets/') ? path.resolve(dist, `.${url.pathname}`) : path.join(dist, 'index.html')
      if (!asset.startsWith(`${dist}${path.sep}`) || !fs.existsSync(asset)) return json(res, 404, { error: '页面不存在，请先运行 npm run build' })
      const ext = path.extname(asset)
      const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable' })
      return fs.createReadStream(asset).pipe(res)
    } catch (error) {
      console.error(error)
      if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : '服务暂时不可用' })
      else res.destroy()
    }
  })
  server.on('close', () => store.close())
  return server
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const password = process.env.ADMIN_PASSWORD
  const server = createApp({ dataDir: process.env.DATA_DIR || path.join(ROOT, 'data'), password })
  const port = Number(process.env.PORT || 3000)
  const host = process.env.HOST || '127.0.0.1'
  server.listen(port, host, () => console.log(`日报登记服务：http://${host}:${port}`))
}
