import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '../server/index.js'
import { storeAt } from '../server/store.js'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/UioAAAAASUVORK5CYII='

test('上传、当日排序、跨日归档和管理员查看截图', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-'))
  let current = new Date('2026-09-23T10:00:00.000Z')
  const server = createApp({ dataDir, password: 'test-password', now: () => current })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const request = async (url, options = {}) => {
    const response = await fetch(`${origin}${url}`, options)
    const body = response.headers.get('content-type')?.includes('json') ? await response.json() : null
    return { response, body }
  }

  try {
    const meta = await request('/api/meta')
    assert.equal(meta.body.today, '2026-09-23')
    assert.equal(meta.body.roster.length, 33)
    assert.equal((await request('/api/admin/day')).response.status, 401)

    const login = await request('/api/admin/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'test-password' }),
    })
    assert.equal(login.response.status, 200)
    const cookie = login.response.headers.get('set-cookie').split(';')[0]
    const auth = { cookie }
    assert.equal((await request('/api/admin/day', { headers: auth })).body.submitted, 0)

    const upload = () => request('/api/upload', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-09-23', personId: 'p14', image: PNG }),
    })
    const first = await upload()
    assert.equal(first.response.status, 201)
    assert.equal((await upload()).body.count, 2)
    const my = (await request('/api/my?personId=p14&date=2026-09-23')).body
    assert.equal(my.images.length, 2)
    assert.equal(my.recent[0].date, '2026-09-23')
    assert.equal(my.recent[0].count, 2)
    assert.equal(my.recent[1].listed, false)

    // 原始二进制上传（新页面使用的方式）
    const raw = await request('/api/upload?personId=p02&date=2026-09-23', {
      method: 'POST', headers: { 'content-type': 'image/png' }, body: Buffer.from(PNG.split(',')[1], 'base64'),
    })
    assert.equal(raw.response.status, 201)
    const bad = await request('/api/upload?personId=p02&date=2026-09-23', { method: 'POST', headers: { 'content-type': 'image/png' }, body: 'not an image' })
    assert.equal(bad.response.status, 400)

    // 员工只能凭上传时拿到的 key 查看或删除自己的图
    const mine = `/api/image/${first.body.id}`
    assert.equal((await request(`${mine}?key=wrong`)).response.status, 404)
    assert.equal((await request(`${mine}?key=${first.body.key}`)).response.status, 200)
    assert.equal((await request(mine, { method: 'DELETE', headers: { 'x-image-key': 'wrong' } })).response.status, 404)
    assert.equal((await request(mine, { method: 'DELETE', headers: { 'x-image-key': first.body.key } })).response.status, 200)
    assert.equal((await request('/api/my?personId=p14&date=2026-09-23')).body.images.length, 1)

    const day = (await request('/api/admin/day?date=2026-09-23', { headers: auth })).body
    assert.equal(day.total, 33)
    assert.equal(day.submitted, 2)
    assert.equal(day.people[0].submitted, false)
    assert.deepEqual(day.people.slice(-2).map((person) => person.name), ['唐鸿志', '赵健鹏'])
    const imageUrl = `/api/admin/image/${day.people.at(-1).images[0].id}`
    assert.equal((await request(imageUrl)).response.status, 401)
    const image = await request(imageUrl, { headers: auth })
    assert.equal(image.response.status, 200)
    assert.equal(image.response.headers.get('content-type'), 'image/png')

    const zip = await fetch(`${origin}/api/admin/zip?date=2026-09-23`, { headers: auth })
    assert.equal(zip.status, 200)
    const zipBytes = Buffer.from(await zip.arrayBuffer())
    assert.equal(zipBytes.readUInt32LE(0), 0x04034b50)
    assert.equal(zipBytes.readUInt16LE(zipBytes.length - 22 + 10), 2)
    assert.ok(zipBytes.includes(Buffer.from('14-赵健鹏.png')))

    // 会话保存在数据库，重启服务后仍然有效
    assert.equal((await request('/api/admin/status', { headers: auth })).response.status, 200)

    current = new Date('2026-09-23T16:00:01.000Z')
    assert.equal((await request('/api/meta')).body.today, '2026-09-24')
    assert.equal((await request('/api/admin/day', { headers: auth })).body.submitted, 0)
    assert.equal((await request('/api/admin/day?date=2026-09-23', { headers: auth })).body.submitted, 2)

    const range = (await request('/api/admin/range?from=2026-09-22&to=2026-09-24', { headers: auth })).body
    assert.deepEqual(range.dates, ['2026-09-22', '2026-09-23', '2026-09-24'])
    const zhao = range.people.find((person) => person.name === '赵健鹏')
    assert.deepEqual(zhao.days, { '2026-09-23': 1, '2026-09-24': 0 })

    // 名单调整：今天生效，历史保留
    const names = (await request('/api/admin/roster', { headers: auth })).body.roster.map((person) => person.name)
    const edited = [...names.filter((name) => name !== '王晓萍'), '新同事']
    const saved = await request('/api/admin/roster', {
      method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ names: edited }),
    })
    assert.equal(saved.response.status, 200)
    assert.equal(saved.body.roster.at(-1).id, 'p34')
    const todayList = (await request('/api/admin/day', { headers: auth })).body.people.map((person) => person.name)
    assert.ok(todayList.includes('新同事'))
    assert.ok(!todayList.includes('王晓萍'))
    const yesterday = (await request('/api/admin/day?date=2026-09-23', { headers: auth })).body.people.map((person) => person.name)
    assert.ok(yesterday.includes('王晓萍'))
    assert.equal((await request('/api/upload?personId=p01&date=2026-09-24', { method: 'POST', headers: { 'content-type': 'image/png' }, body: Buffer.from(PNG.split(',')[1], 'base64') })).response.status, 400)
    const duplicate = await request('/api/admin/roster', {
      method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ names: ['甲', '甲'] }),
    })
    assert.equal(duplicate.response.status, 400)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('旧 JSON 记录迁入 SQLite，截图与原文件保留', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-migrate-'))
  const imageId = '11111111-2222-4333-8444-555555555555'
  const filename = `${imageId}.png`
  fs.mkdirSync(path.join(dataDir, 'uploads'))
  fs.writeFileSync(path.join(dataDir, 'uploads', filename), Buffer.from(PNG.split(',')[1], 'base64'))
  const legacy = { days: { '2026-09-22': {
    people: [{ id: 'p14', name: '赵健鹏' }],
    submissions: { p14: [{ id: imageId, filename, mime: 'image/png', uploadedAt: '2026-09-22T10:42:00.000Z' }] },
  } } }
  fs.writeFileSync(path.join(dataDir, 'records.json'), JSON.stringify(legacy))

  try {
    const store = storeAt(dataDir)
    assert.deepEqual(store.day('2026-09-22').people.map((person) => person.name), ['赵健鹏'])
    assert.equal(store.uploads('2026-09-22', 'p14')[0].id, imageId)
    assert.equal(fs.existsSync(store.image(imageId).filePath), true)
    store.close()

    const reopened = storeAt(dataDir)
    assert.equal(reopened.uploads('2026-09-22', 'p14')[0].id, imageId)
    reopened.close()
    assert.equal(fs.existsSync(path.join(dataDir, 'records.json')), true)
    assert.equal(fs.existsSync(path.join(dataDir, 'records.sqlite')), true)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('旧版多次上传只保留最后一张，管理员会话跨重启保留', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-multi-'))
  const ids = ['11111111-2222-4333-8444-555555555551', '11111111-2222-4333-8444-555555555552']
  fs.mkdirSync(path.join(dataDir, 'uploads'))
  for (const id of ids) fs.writeFileSync(path.join(dataDir, 'uploads', `${id}.png`), Buffer.from(PNG.split(',')[1], 'base64'))
  const legacy = { days: { '2026-09-22': {
    people: [{ id: 'p14', name: '赵健鹏' }],
    submissions: { p14: ids.map((id, index) => ({ id, filename: `${id}.png`, mime: 'image/png', uploadedAt: `2026-09-22T10:4${index}:00.000Z` })) },
  } } }
  fs.writeFileSync(path.join(dataDir, 'records.json'), JSON.stringify(legacy))

  try {
    const store = storeAt(dataDir)
    assert.deepEqual(store.uploads('2026-09-22', 'p14').map((row) => row.id), [ids[1]])
    store.sessions.create('token', Date.now() + 60_000)
    store.close()
    const reopened = storeAt(dataDir)
    assert.equal(reopened.sessions.valid('token'), true)
    assert.equal(reopened.sessions.valid('other'), false)
    assert.equal(reopened.activePeople().length, 33)
    reopened.close()
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
