export async function api(url, options = {}) {
  let response
  try {
    response = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers: { ...(typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    })
  } catch {
    throw new Error('网络不太好，请稍后重试')
  }
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error(body.error || '请求失败'), { status: response.status })
  return body
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六']

export function weekday(value) {
  return `周${WEEK[new Date(`${value}T00:00:00Z`).getUTCDay()]}`
}

export function displayDate(value, { week = false } = {}) {
  if (!value) return ''
  const [, month, day] = value.split('-')
  return `${Number(month)}月${Number(day)}日${week ? ` ${weekday(value)}` : ''}`
}

export function addDays(value, days) {
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function timeOf(iso) {
  if (!iso) return ''
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso))
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  }
}

const DIRECT_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const MAX_DIRECT_BYTES = 2.5 * 1024 * 1024
const MAX_WIDTH = 1600
const MAX_PIXELS = 16_000_000

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => { URL.revokeObjectURL(url); resolve(image) }
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法读取这张图片，请换一张截图')) }
    image.src = url
  })
}

// 小截图原样上传；大图、HEIC 等格式在手机上先缩放转 JPG，上传更快也不会超限。
export async function prepareImage(file) {
  if (DIRECT_TYPES.includes(file.type) && file.size <= MAX_DIRECT_BYTES) return file
  if (file.type && !file.type.startsWith('image/')) throw new Error('请选择图片')
  const image = await loadImage(file)
  let scale = Math.min(1, MAX_WIDTH / image.naturalWidth)
  scale = Math.min(scale, Math.sqrt(MAX_PIXELS / (image.naturalWidth * image.naturalHeight)))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
  const context = canvas.getContext('2d')
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88))
  if (!blob) throw new Error('图片处理失败，请换一张截图')
  return blob
}

export function uploadImage({ personId, date, file, onProgress }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/upload?personId=${encodeURIComponent(personId)}&date=${date}`)
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress?.(event.loaded / event.total) }
    xhr.onload = () => {
      let body = {}
      try { body = JSON.parse(xhr.responseText) } catch { /* 非 JSON 响应 */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body)
      else reject(new Error(body.error || (xhr.status === 413 ? '图片太大' : '上传失败，请重试')))
    }
    xhr.onerror = () => reject(new Error('网络不太好，上传失败，请重试'))
    xhr.send(file)
  })
}
