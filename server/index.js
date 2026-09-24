import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { storeAt } from './store.js'
import { writeZip } from './zip.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_BODY_BYTES = 11 * 1024 * 1024 + 1024
const SESSION_MS = 30 * 24 * 60 * 60 * 1000

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

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) tooLarge = true
      else chunks.push(chunk)
    })
    req.on('end', () => (tooLarge ? reject(Object.assign(new Error('图片不能超过 8 MB'), { status: 413 })) : resolve(Buffer.concat(chunks))))
    req.on('error', reject)
  })
}

async function readJson(req) {
  const body = await readBody(req, MAX_BODY_BYTES)
  try { return JSON.parse(body.toString('utf8') || '{}') }
  catch { throw Object.assign(new Error('请求格式不正确'), { status: 400 }) }
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function cookie(req, name) {
  return (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1)
}

function clientIp(req) {
  const remote = req.socket.remoteAddress || 'unknown'
  // 经本机 Nginx 转发时，按真实来源 IP 限制登录尝试，避免一人输错锁住所有人
  if (/^(::ffff:)?127\.|^::1$/.test(remote)) return String(req.headers['x-real-ip'] || remote)
  return remote
}

export function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

function sendImage(res, image) {
  if (!image || !fs.existsSync(image.filePath)) return json(res, 404, { error: '图片不存在' })
  res.writeHead(200, { 'Content-Type': image.mime, 'Cache-Control': 'private, max-age=86400' })
  return fs.createReadStream(image.filePath).pipe(res)
}

const IMAGE_PATH = /^\/api\/(admin\/)?image\/([0-9a-f-]{36})$/

export function createApp({ dataDir = path.join(ROOT, 'data'), password, now = () => new Date() } = {}) {
  if (!password) throw new Error('请设置 ADMIN_PASSWORD')
  const store = storeAt(dataDir)
  const attempts = new Map()
  const passHash = crypto.createHash('sha256').update(password).digest()
  const authorized = (req) => store.sessions.valid(cookie(req, 'daily_admin'))
  const isPerson = (id) => store.activePeople().some((person) => person.id === id)

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'same-origin')
    const url = new URL(req.url, 'http://localhost')
    const today = shanghaiDate(now())
    const date = url.searchParams.get('date') || today
    const imageMatch = url.pathname.match(IMAGE_PATH)

    try {
      if (req.method === 'GET' && url.pathname === '/api/meta') {
        store.day(today)
        return json(res, 200, { today, roster: store.activePeople() })
      }
      if (req.method === 'GET' && url.pathname === '/api/my') {
        if (!validDate(date, today)) return json(res, 400, { error: '日期不正确' })
        const personId = url.searchParams.get('personId')
        if (!isPerson(personId)) return json(res, 400, { error: '请选择姓名' })
        const from = addDays(today, -13)
        const counts = new Map(store.history(personId, from, today).map((row) => [row.date, row.count]))
        // listed=false 表示那天此人不在名单中（如系统启用前），不算缺交
        const recent = Array.from({ length: 14 }, (_, index) => addDays(today, -index))
          .map((day) => ({ date: day, count: counts.get(day) || 0, listed: counts.has(day) }))
        return json(res, 200, { date, images: store.uploads(date, personId), recent })
      }
      if (req.method === 'POST' && url.pathname === '/api/upload') {
        let personId = url.searchParams.get('personId')
        let uploadDate = url.searchParams.get('date')
        let bytes
        if ((req.headers['content-type'] || '').includes('application/json')) {
          // 兼容旧页面的 base64 JSON 上传
          const body = await readJson(req)
          personId = body.personId
          uploadDate = body.date
          if (typeof body.image !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(body.image)) {
            return json(res, 400, { error: '请选择 PNG、JPG 或 WebP 图片' })
          }
          bytes = Buffer.from(body.image.slice(body.image.indexOf(',') + 1), 'base64')
        } else {
          bytes = await readBody(req, MAX_IMAGE_BYTES)
        }
        if (!validDate(uploadDate, today)) return json(res, 400, { error: '日期不正确' })
        if (!isPerson(personId)) return json(res, 400, { error: '请选择姓名' })
        const type = imageType(bytes)
        if (!type || bytes.length === 0) return json(res, 400, { error: '图片格式不正确，请选择截图' })
        if (bytes.length > MAX_IMAGE_BYTES) return json(res, 413, { error: '图片不能超过 8 MB' })
        const record = store.add(uploadDate, personId, bytes, type, now().toISOString())
        if (!record) return json(res, 400, { error: '名单中没有此人' })
        return json(res, 201, { submitted: true, ...record, count: store.uploads(uploadDate, personId).length })
      }
      if (imageMatch && !imageMatch[1]) {
        const image = store.image(imageMatch[2])
        const key = req.method === 'DELETE' ? req.headers['x-image-key'] : url.searchParams.get('key')
        if (!store.keyMatches(image, key)) return json(res, 404, { error: '图片不存在' })
        if (req.method === 'GET') return sendImage(res, image)
        if (req.method === 'DELETE') {
          store.remove(imageMatch[2], now().toISOString())
          return json(res, 200, { ok: true })
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/admin/login') {
        const ip = clientIp(req)
        const prior = attempts.get(ip)
        if (prior && prior.until > Date.now() && prior.count >= 5) return json(res, 429, { error: '尝试次数过多，请 15 分钟后再试' })
        const body = await readJson(req)
        const candidate = crypto.createHash('sha256').update(String(body.password || '')).digest()
        if (!crypto.timingSafeEqual(candidate, passHash)) {
          const count = prior && prior.until > Date.now() ? prior.count + 1 : 1
          attempts.set(ip, { count, until: Date.now() + 15 * 60 * 1000 })
          return json(res, 401, { error: '密码不正确' })
        }
        attempts.delete(ip)
        const token = crypto.randomBytes(32).toString('hex')
        store.sessions.create(token, Date.now() + SESSION_MS)
        const secure = process.env.PUBLIC_HTTPS === '1' ? '; Secure' : ''
        res.setHeader('Set-Cookie', `daily_admin=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`)
        return json(res, 200, { ok: true })
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/logout') {
        store.sessions.remove(cookie(req, 'daily_admin'))
        res.setHeader('Set-Cookie', 'daily_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0')
        return json(res, 200, { ok: true })
      }
      if (url.pathname.startsWith('/api/admin/') && !authorized(req)) return json(res, 401, { error: '请先登录' })
      if (req.method === 'GET' && url.pathname === '/api/admin/status') return json(res, 200, { ok: true })
      if (req.method === 'GET' && url.pathname === '/api/admin/day') {
        if (!validDate(date, today)) return json(res, 400, { error: '日期不正确' })
        const people = store.dayDetail(date).map((person) => ({ ...person, submitted: person.images.length > 0 }))
          .sort((a, b) => Number(a.submitted) - Number(b.submitted) || a.ordinal - b.ordinal)
        return json(res, 200, { date, today, total: people.length, submitted: people.filter((person) => person.submitted).length, people })
      }
      if (imageMatch && imageMatch[1]) {
        if (req.method === 'GET') return sendImage(res, store.image(imageMatch[2]))
        if (req.method === 'DELETE') {
          return store.remove(imageMatch[2], now().toISOString()) ? json(res, 200, { ok: true }) : json(res, 404, { error: '图片不存在' })
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/range') {
        const to = url.searchParams.get('to') || today
        const from = url.searchParams.get('from') || addDays(to, -6)
        if (!validDate(from, today) || !validDate(to, today) || from > to || addDays(from, 92) < to) return json(res, 400, { error: '日期范围不正确（最长 93 天）' })
        const dates = []
        for (let day = from; day <= to; day = addDays(day, 1)) dates.push(day)
        const { members, counts } = store.range(from, to)
        const countOf = new Map(counts.map((row) => [`${row.date}|${row.personId}`, row.count]))
        const active = store.activePeople()
        const order = new Map(active.map((person, index) => [person.id, index]))
        const people = new Map(active.map((person) => [person.id, { id: person.id, name: person.name, active: true, days: {} }]))
        for (const member of members) {
          if (!people.has(member.personId)) people.set(member.personId, { id: member.personId, name: member.name, active: false, days: {} })
          people.get(member.personId).days[member.date] = countOf.get(`${member.date}|${member.personId}`) || 0
        }
        const list = [...people.values()].filter((person) => person.active || Object.keys(person.days).length)
          .sort((a, b) => (order.get(a.id) ?? 9999) - (order.get(b.id) ?? 9999))
        return json(res, 200, { from, to, dates, people: list })
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/roster') {
        return json(res, 200, { roster: store.activePeople() })
      }
      if (req.method === 'PUT' && url.pathname === '/api/admin/roster') {
        const body = await readJson(req)
        const names = Array.isArray(body.names) ? body.names.map((name) => String(name).trim()).filter(Boolean) : []
        if (names.length === 0) return json(res, 400, { error: '名单不能为空' })
        if (names.length > 300) return json(res, 400, { error: '名单最多 300 人' })
        if (names.some((name) => name.length > 20)) return json(res, 400, { error: '姓名不能超过 20 个字' })
        const duplicate = names.find((name, index) => names.indexOf(name) !== index)
        if (duplicate) return json(res, 400, { error: `姓名重复：${duplicate}` })
        return json(res, 200, { roster: store.setRoster(names, today) })
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/zip') {
        if (!validDate(date, today)) return json(res, 400, { error: '日期不正确' })
        const entries = []
        for (const person of store.dayDetail(date)) {
          person.images.forEach((item, index) => {
            const image = store.image(item.id)
            if (!image || !fs.existsSync(image.filePath)) return
            const suffix = person.images.length > 1 ? `-${index + 1}` : ''
            entries.push({ filePath: image.filePath, name: `${date}/${String(person.ordinal).padStart(2, '0')}-${person.name}${suffix}${path.extname(image.filePath)}`, date: item.uploadedAt })
          })
        }
        if (entries.length === 0) return json(res, 404, { error: '当天还没有截图' })
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="daily-${date}.zip"; filename*=UTF-8''${encodeURIComponent(`日报截图-${date}.zip`)}`,
          'Cache-Control': 'no-store',
        })
        return await writeZip(res, entries)
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
