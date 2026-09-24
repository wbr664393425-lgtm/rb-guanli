import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { roster as initialRoster } from './roster.js'

const IMAGE_NAME = /^[0-9a-f-]{36}\.(png|jpg|webp)$/
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')

export function storeAt(dataDir) {
  const file = path.join(dataDir, 'records.sqlite')
  const legacyFile = path.join(dataDir, 'records.json')
  const uploadDir = path.join(dataDir, 'uploads')
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  fs.mkdirSync(uploadDir, { recursive: true, mode: 0o700 })

  const db = new DatabaseSync(file)
  fs.chmodSync(file, 0o600)
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS people (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS day_people (
      date TEXT NOT NULL,
      person_id TEXT NOT NULL,
      name TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (date, person_id)
    );
    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      person_id TEXT NOT NULL,
      filename TEXT NOT NULL UNIQUE,
      mime TEXT NOT NULL,
      uploaded_at TEXT NOT NULL,
      FOREIGN KEY (date, person_id) REFERENCES day_people (date, person_id)
    );
    CREATE INDEX IF NOT EXISTS submissions_by_day_person
      ON submissions (date, person_id, uploaded_at DESC);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
  `)
  const columns = db.prepare('PRAGMA table_info(submissions)').all().map((column) => column.name)
  if (!columns.includes('deleted_at')) db.exec('ALTER TABLE submissions ADD COLUMN deleted_at TEXT')
  if (!columns.includes('key_hash')) db.exec('ALTER TABLE submissions ADD COLUMN key_hash TEXT')

  const getMeta = db.prepare('SELECT value FROM meta WHERE key = ?')
  const setMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
  const insertPerson = db.prepare('INSERT OR IGNORE INTO day_people (date, person_id, name, ordinal) VALUES (?, ?, ?, ?)')
  const insertSubmission = db.prepare('INSERT INTO submissions (id, date, person_id, filename, mime, uploaded_at, key_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const importSubmission = db.prepare('INSERT OR IGNORE INTO submissions (id, date, person_id, filename, mime, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)')
  const selectDayPeople = db.prepare('SELECT person_id AS id, name FROM day_people WHERE date = ? ORDER BY ordinal')
  const selectActive = db.prepare('SELECT id, name FROM people WHERE active = 1 ORDER BY ordinal')
  const selectUploads = db.prepare(`SELECT id, uploaded_at AS uploadedAt FROM submissions
    WHERE date = ? AND person_id = ? AND deleted_at IS NULL ORDER BY uploaded_at, rowid`)
  const selectDayUploads = db.prepare(`SELECT id, person_id AS personId, uploaded_at AS uploadedAt FROM submissions
    WHERE date = ? AND deleted_at IS NULL ORDER BY uploaded_at, rowid`)
  const selectImage = db.prepare('SELECT filename, mime, key_hash AS keyHash, date, person_id AS personId FROM submissions WHERE id = ? AND deleted_at IS NULL')
  const softDelete = db.prepare('UPDATE submissions SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  function migrateLegacy() {
    if (!fs.existsSync(legacyFile) || getMeta.get('json_imported')) return
    const old = JSON.parse(fs.readFileSync(legacyFile, 'utf8'))
    if (!old || typeof old.days !== 'object' || Array.isArray(old.days)) throw new Error('旧记录文件格式不正确，未执行迁移')

    let imported = 0
    transaction(() => {
      for (const [date, entry] of Object.entries(old.days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Array.isArray(entry.people) || !entry.submissions || typeof entry.submissions !== 'object') {
          throw new Error('旧记录日期或名单格式不正确，未执行迁移')
        }
        entry.people.forEach((person, index) => {
          if (!person.id || !person.name) throw new Error('旧名单格式不正确，未执行迁移')
          insertPerson.run(date, person.id, person.name, index + 1)
        })
        for (const [personId, records] of Object.entries(entry.submissions)) {
          if (!Array.isArray(records)) throw new Error('旧提交记录格式不正确，未执行迁移')
          for (const record of records) {
            if (!IMAGE_NAME.test(record.filename) || !fs.existsSync(path.join(uploadDir, record.filename))) {
              throw new Error(`旧截图文件缺失或名称不正确：${record.filename}`)
            }
            importSubmission.run(record.id, date, personId, record.filename, record.mime, record.uploadedAt)
            imported += 1
          }
        }
      }
      setMeta.run('json_imported', '1')
    })
    console.log(`已迁移旧 JSON 记录：${Object.keys(old.days).length} 天、${imported} 张截图；原文件保留`)
  }

  // 旧版每人每天只认最后一张（重新上传即替换），多图版本把被替换的旧图标记为已删除，文件保留。
  function migrateMultiImage() {
    if (getMeta.get('multi_image')) return
    transaction(() => {
      db.exec(`UPDATE submissions SET deleted_at = uploaded_at WHERE deleted_at IS NULL AND rowid NOT IN (
        SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER (PARTITION BY date, person_id ORDER BY uploaded_at DESC, rowid DESC) AS rn FROM submissions)
        WHERE rn = 1)`)
      setMeta.run('multi_image', '1')
    })
  }

  function seedPeople() {
    if (db.prepare('SELECT COUNT(*) AS n FROM people').get().n > 0) return
    transaction(() => {
      const insert = db.prepare('INSERT OR IGNORE INTO people (id, name, ordinal, active) VALUES (?, ?, ?, ?)')
      initialRoster.forEach((person, index) => insert.run(person.id, person.name, index + 1, 1))
      db.prepare('SELECT DISTINCT person_id AS id, name FROM day_people').all()
        .forEach((person, index) => insert.run(person.id, person.name, 1000 + index, 0))
    })
  }

  try {
    migrateLegacy()
    migrateMultiImage()
    seedPeople()
  } catch (error) { db.close(); throw error }

  function activePeople() {
    return selectActive.all()
  }

  function day(date) {
    let people = selectDayPeople.all(date)
    if (people.length === 0) {
      transaction(() => activePeople().forEach((person, index) => insertPerson.run(date, person.id, person.name, index + 1)))
      people = selectDayPeople.all(date)
    }
    return { people }
  }

  function uploads(date, personId) {
    return selectUploads.all(date, personId)
  }

  function dayDetail(date) {
    const { people } = day(date)
    const byPerson = new Map()
    for (const row of selectDayUploads.all(date)) {
      if (!byPerson.has(row.personId)) byPerson.set(row.personId, [])
      byPerson.get(row.personId).push({ id: row.id, uploadedAt: row.uploadedAt })
    }
    return people.map((person, index) => ({ ...person, ordinal: index + 1, images: byPerson.get(person.id) || [] }))
  }

  function add(date, personId, bytes, type, uploadedAt) {
    const people = day(date).people
    if (!people.some((person) => person.id === personId)) {
      // 后加入名单的人补交早期日期时，把他并入当天名单
      const person = activePeople().find((entry) => entry.id === personId)
      if (!person) return null
      insertPerson.run(date, person.id, person.name, people.length + 1)
    }
    const id = crypto.randomUUID()
    const key = crypto.randomBytes(18).toString('base64url')
    const filename = `${id}.${type.ext}`
    const filePath = path.join(uploadDir, filename)
    fs.writeFileSync(filePath, bytes, { flag: 'wx', mode: 0o600 })
    try {
      transaction(() => insertSubmission.run(id, date, personId, filename, type.mime, uploadedAt, sha256(key)))
    } catch (error) {
      fs.unlinkSync(filePath)
      throw error
    }
    return { id, uploadedAt, key }
  }

  function image(id) {
    const row = selectImage.get(id)
    if (!row || !IMAGE_NAME.test(row.filename)) return null
    return { filePath: path.join(uploadDir, row.filename), mime: row.mime, keyHash: row.keyHash, date: row.date, personId: row.personId }
  }

  function keyMatches(row, key) {
    if (!row?.keyHash || typeof key !== 'string' || !key) return false
    return crypto.timingSafeEqual(Buffer.from(sha256(key)), Buffer.from(row.keyHash))
  }

  function remove(id, deletedAt) {
    return softDelete.run(deletedAt, id).changes > 0
  }

  function history(personId, from, to) {
    return db.prepare(`SELECT d.date, COUNT(s.id) AS count FROM day_people d
      LEFT JOIN submissions s ON s.date = d.date AND s.person_id = d.person_id AND s.deleted_at IS NULL
      WHERE d.person_id = ? AND d.date BETWEEN ? AND ? GROUP BY d.date`).all(personId, from, to)
  }

  function range(from, to) {
    const members = db.prepare('SELECT date, person_id AS personId, name, ordinal FROM day_people WHERE date BETWEEN ? AND ?').all(from, to)
    const counts = db.prepare(`SELECT date, person_id AS personId, COUNT(*) AS count FROM submissions
      WHERE deleted_at IS NULL AND date BETWEEN ? AND ? GROUP BY date, person_id`).all(from, to)
    return { members, counts }
  }

  function setRoster(names, today) {
    return transaction(() => {
      const all = db.prepare('SELECT id, name FROM people').all()
      const byName = new Map(all.map((person) => [person.name, person.id]))
      let next = Math.max(0, ...all.map((person) => Number(person.id.replace(/^p/, '')) || 0)) + 1
      db.exec('UPDATE people SET active = 0')
      const upsert = db.prepare('INSERT INTO people (id, name, ordinal, active) VALUES (?, ?, ?, 1) ON CONFLICT (id) DO UPDATE SET ordinal = excluded.ordinal, active = 1')
      names.forEach((name, index) => {
        let id = byName.get(name)
        if (!id) { id = `p${String(next).padStart(2, '0')}`; next += 1 }
        upsert.run(id, name, index + 1)
      })
      // 今天的名单跟着调整；历史日期保持当时的名单
      if (db.prepare('SELECT 1 FROM day_people WHERE date = ? LIMIT 1').get(today)) {
        db.prepare(`DELETE FROM day_people WHERE date = ? AND person_id NOT IN (SELECT id FROM people WHERE active = 1)
          AND person_id NOT IN (SELECT person_id FROM submissions WHERE date = ?)`).run(today, today)
        const reorder = db.prepare('INSERT INTO day_people (date, person_id, name, ordinal) VALUES (?, ?, ?, ?) ON CONFLICT (date, person_id) DO UPDATE SET ordinal = excluded.ordinal')
        activePeople().forEach((person, index) => reorder.run(today, person.id, person.name, index + 1))
      }
      return activePeople()
    })
  }

  const sessions = {
    create(token, expiresAt) {
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now())
      db.prepare('INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)').run(sha256(token), expiresAt)
    },
    valid(token) {
      if (!token) return false
      const row = db.prepare('SELECT expires_at AS expiresAt FROM sessions WHERE token_hash = ?').get(sha256(token))
      return Boolean(row && row.expiresAt > Date.now())
    },
    remove(token) {
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token))
    },
  }

  return { activePeople, day, dayDetail, uploads, add, image, keyMatches, remove, history, range, setRoster, sessions, close: () => db.close() }
}
