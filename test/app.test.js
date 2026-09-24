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
    assert.equal((await upload()).response.status, 201)
    assert.equal((await upload()).response.status, 201)
    assert.equal((await request('/api/my?personId=p14&date=2026-09-23')).body.submitted, true)

    const day = (await request('/api/admin/day?date=2026-09-23', { headers: auth })).body
    assert.equal(day.total, 33)
    assert.equal(day.submitted, 1)
    assert.equal(day.people[0].submitted, false)
    assert.equal(day.people.at(-1).name, '赵健鹏')
    const imageUrl = `/api/admin/image/${day.people.at(-1).imageId}`
    assert.equal((await request(imageUrl)).response.status, 401)
    const image = await request(imageUrl, { headers: auth })
    assert.equal(image.response.status, 200)
    assert.equal(image.response.headers.get('content-type'), 'image/png')

    current = new Date('2026-09-23T16:00:01.000Z')
    assert.equal((await request('/api/meta')).body.today, '2026-09-24')
    assert.equal((await request('/api/admin/day', { headers: auth })).body.submitted, 0)
    assert.equal((await request('/api/admin/day?date=2026-09-23', { headers: auth })).body.submitted, 1)
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
    assert.equal(store.latest('2026-09-22', 'p14').id, imageId)
    assert.equal(fs.existsSync(store.image(imageId).filePath), true)
    store.close()

    const reopened = storeAt(dataDir)
    assert.equal(reopened.latest('2026-09-22', 'p14').id, imageId)
    reopened.close()
    assert.equal(fs.existsSync(path.join(dataDir, 'records.json')), true)
    assert.equal(fs.existsSync(path.join(dataDir, 'records.sqlite')), true)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
