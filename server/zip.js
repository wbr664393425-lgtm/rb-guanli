import fs from 'node:fs'
import zlib from 'node:zlib'

// 截图本身已压缩，这里只做不压缩（stored）的 ZIP 打包，逐个文件写出，避免把整包放进内存。
export async function writeZip(out, entries) {
  const central = []
  let offset = 0
  const write = (chunk) => new Promise((resolve, reject) => {
    offset += chunk.length
    out.write(chunk, (error) => (error ? reject(error) : resolve()))
  })

  for (const entry of entries) {
    const data = await fs.promises.readFile(entry.filePath)
    const name = Buffer.from(entry.name, 'utf8')
    const crc = zlib.crc32(data)
    const [time, date] = dosTime(entry.date || new Date())
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0800, 6) // UTF-8 文件名
    header.writeUInt16LE(0, 8)
    header.writeUInt16LE(time, 10)
    header.writeUInt16LE(date, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(data.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(0, 28)
    central.push({ name, crc, size: data.length, time, date, offset })
    await write(header)
    await write(name)
    await write(data)
  }

  const start = offset
  for (const item of central) {
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(0x0800, 8)
    record.writeUInt16LE(0, 10)
    record.writeUInt16LE(item.time, 12)
    record.writeUInt16LE(item.date, 14)
    record.writeUInt32LE(item.crc, 16)
    record.writeUInt32LE(item.size, 20)
    record.writeUInt32LE(item.size, 24)
    record.writeUInt16LE(item.name.length, 28)
    record.writeUInt32LE(item.offset, 42)
    await write(record)
    await write(item.name)
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(central.length, 8)
  end.writeUInt16LE(central.length, 10)
  end.writeUInt32LE(offset - start, 12)
  end.writeUInt32LE(start, 16)
  await write(end)
  out.end()
}

function dosTime(value) {
  const d = new Date(new Date(value).getTime() + 8 * 60 * 60 * 1000) // 按北京时间记录
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2)
  const date = ((Math.max(d.getUTCFullYear(), 1980) - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate()
  return [time, date]
}
