import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { roster } from './roster.js'

const IMAGE_NAME = /^[0-9a-f-]{36}\.(png|jpg|webp)$/

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
  `)

  const insertPerson = db.prepare('INSERT OR IGNORE INTO day_people (date, person_id, name, ordinal) VALUES (?, ?, ?, ?)')
  const insertSubmission = db.prepare('INSERT INTO submissions (id, date, person_id, filename, mime, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)')
  const importSubmission = db.prepare('INSERT OR IGNORE INTO submissions (id, date, person_id, filename, mime, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)')
  const selectPeople = db.prepare('SELECT person_id AS id, name FROM day_people WHERE date = ? ORDER BY ordinal')
  const selectLatest = db.prepare('SELECT id, uploaded_at AS uploadedAt FROM submissions WHERE date = ? AND person_id = ? ORDER BY uploaded_at DESC, rowid DESC LIMIT 1')
  const selectImage = db.prepare('SELECT filename, mime FROM submissions WHERE id = ?')

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE')
    try {
      work()
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  function migrateLegacy() {
    if (!fs.existsSync(legacyFile) || db.prepare("SELECT value FROM meta WHERE key = 'json_imported'").get()) return
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
      db.prepare("INSERT INTO meta (key, value) VALUES ('json_imported', '1')").run()
    })
    console.log(`已迁移旧 JSON 记录：${Object.keys(old.days).length} 天、${imported} 张截图；原文件保留`)
  }

  try { migrateLegacy() }
  catch (error) { db.close(); throw error }

  function day(date) {
    let people = selectPeople.all(date)
    if (people.length === 0) {
      transaction(() => roster.forEach((person, index) => insertPerson.run(date, person.id, person.name, index + 1)))
      people = selectPeople.all(date)
    }
    return { people }
  }

  function latest(date, personId) {
    day(date)
    return selectLatest.get(date, personId) || null
  }

  function add(date, personId, bytes, type, uploadedAt) {
    if (!day(date).people.some((person) => person.id === personId)) return null
    const id = crypto.randomUUID()
    const filename = `${id}.${type.ext}`
    const filePath = path.join(uploadDir, filename)
    fs.writeFileSync(filePath, bytes, { flag: 'wx', mode: 0o600 })
    try {
      transaction(() => insertSubmission.run(id, date, personId, filename, type.mime, uploadedAt))
    } catch (error) {
      fs.unlinkSync(filePath)
      throw error
    }
    return { id, uploadedAt }
  }

  function image(id) {
    const row = selectImage.get(id)
    if (!row || !IMAGE_NAME.test(row.filename)) return null
    return { filePath: path.join(uploadDir, row.filename), mime: row.mime }
  }

  return { day, latest, add, image, close: () => db.close() }
}
