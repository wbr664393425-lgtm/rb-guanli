<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { api, displayDate, weekday, timeOf, prepareImage, uploadImage } from './api.js'

const PERSON_KEY = 'daily-report-person'
const KEYS_KEY = 'daily-report-keys'

const roster = ref([])
const today = ref('')
const date = ref('')
const personId = ref('')
const choosingName = ref(false)
const images = ref([])
const recent = ref([])
const queue = ref([])
const error = ref('')
const toast = ref('')
const loading = ref(true)
const dragging = ref(false)
const fileInput = ref(null)
const imageKeys = ref(readKeys())
let statusRequest = 0
let refreshTimer
let toastTimer

const person = computed(() => roster.value.find((entry) => entry.id === personId.value))
const isToday = computed(() => date.value === today.value)
const busy = computed(() => queue.value.some((item) => !item.error))
const done = computed(() => images.value.length > 0)
const lastTime = computed(() => timeOf(images.value.at(-1)?.uploadedAt))
const week = computed(() => [...recent.value.slice(0, 7)].reverse())
const missedCount = computed(() => recent.value.slice(1, 7).filter((day) => day.listed && day.count === 0).length)

function readKeys() {
  try { return JSON.parse(localStorage.getItem(KEYS_KEY) || '{}') } catch { return {} }
}

function saveKey(id, key) {
  const entries = Object.entries({ ...imageKeys.value, [id]: key }).slice(-300)
  imageKeys.value = Object.fromEntries(entries)
  try { localStorage.setItem(KEYS_KEY, JSON.stringify(imageKeys.value)) } catch { /* 无痕模式只影响本机预览 */ }
}

function showToast(text) {
  toast.value = text
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = '' }, 2200)
}

function choose(id) {
  personId.value = id
  choosingName.value = false
  try { localStorage.setItem(PERSON_KEY, id) } catch { /* 无痕模式仍可提交 */ }
  loadStatus()
}

function pickDate(value) {
  if (!value || value > today.value || busy.value) return
  date.value = value
  loadStatus()
}

async function loadStatus() {
  const current = ++statusRequest
  error.value = ''
  if (!personId.value || !date.value) return
  try {
    const result = await api(`/api/my?personId=${encodeURIComponent(personId.value)}&date=${date.value}`)
    if (current !== statusRequest) return
    images.value = result.images
    recent.value = result.recent
  } catch (cause) {
    if (current === statusRequest) error.value = cause.message
  }
}

function openPicker() {
  if (!busy.value) fileInput.value?.click()
}

async function acceptFiles(list) {
  const files = [...(list || [])].filter((file) => !file.type || file.type.startsWith('image/'))
  if (fileInput.value) fileInput.value.value = ''
  if (files.length === 0) { if (list?.length) error.value = '请选择图片'; return }
  if (!personId.value) { error.value = '请先选择姓名'; return }
  error.value = ''
  const target = { personId: personId.value, date: date.value }
  const items = files.slice(0, 9).map((file) => ({ key: crypto.randomUUID?.() || String(Math.random()), preview: URL.createObjectURL(file), progress: 0, error: '' }))
  queue.value.push(...items)
  let ok = 0
  for (const [index, file] of files.slice(0, 9).entries()) {
    const item = queue.value.find((entry) => entry.key === items[index].key)
    try {
      const prepared = await prepareImage(file)
      const result = await uploadImage({ ...target, file: prepared, onProgress: (value) => { item.progress = value } })
      saveKey(result.id, result.key)
      if (target.personId === personId.value && target.date === date.value) images.value.push({ id: result.id, uploadedAt: result.uploadedAt })
      const day = recent.value.find((entry) => entry.date === target.date)
      if (day && target.personId === personId.value) Object.assign(day, { count: result.count, listed: true })
      URL.revokeObjectURL(item.preview)
      queue.value = queue.value.filter((entry) => entry.key !== item.key)
      ok += 1
    } catch (cause) {
      item.error = cause.message
    }
  }
  if (ok) showToast(`${displayDate(target.date)}日报已提交 ✓`)
}

function dropQueued(item) {
  URL.revokeObjectURL(item.preview)
  queue.value = queue.value.filter((entry) => entry.key !== item.key)
}

async function removeImage(image) {
  const key = imageKeys.value[image.id]
  if (!key || !window.confirm('删除这张截图？')) return
  try {
    await api(`/api/image/${image.id}`, { method: 'DELETE', headers: { 'X-Image-Key': key } })
    images.value = images.value.filter((entry) => entry.id !== image.id)
    const day = recent.value.find((entry) => entry.date === date.value)
    if (day) day.count = images.value.length
  } catch (cause) { error.value = cause.message }
}

function onDragOver(event) {
  if (!personId.value || choosingName.value) return
  event.preventDefault()
  dragging.value = true
}

function onDrop(event) {
  dragging.value = false
  if (!personId.value || choosingName.value) return
  event.preventDefault()
  acceptFiles(event.dataTransfer?.files)
}

function onPaste(event) {
  if (!personId.value || choosingName.value) return
  const files = [...(event.clipboardData?.items || [])].filter((entry) => entry.kind === 'file' && entry.type.startsWith('image/')).map((entry) => entry.getAsFile())
  if (files.length) {
    event.preventDefault()
    acceptFiles(files)
  }
}

async function refreshDay() {
  try {
    const result = await api('/api/meta')
    roster.value = result.roster
    if (result.today !== today.value) {
      const wasToday = date.value === today.value
      today.value = result.today
      if (wasToday) date.value = result.today
      loadStatus()
    }
  } catch { /* 网络恢复后再次读取 */ }
}

function onVisible() {
  if (document.visibilityState === 'visible') refreshDay()
}

onMounted(async () => {
  window.addEventListener('paste', onPaste)
  document.addEventListener('visibilitychange', onVisible)
  try {
    const result = await api('/api/meta')
    roster.value = result.roster
    today.value = result.today
    date.value = result.today
    let saved = ''
    try { saved = localStorage.getItem(PERSON_KEY) || '' } catch { /* 忽略 */ }
    if (roster.value.some((entry) => entry.id === saved)) personId.value = saved
    await loadStatus()
  } catch (cause) {
    error.value = cause.message
  } finally {
    loading.value = false
  }
  refreshTimer = setInterval(refreshDay, 60_000)
})

onUnmounted(() => {
  window.removeEventListener('paste', onPaste)
  document.removeEventListener('visibilitychange', onVisible)
  clearInterval(refreshTimer)
  clearTimeout(toastTimer)
  queue.value.forEach((item) => URL.revokeObjectURL(item.preview))
})
</script>

<template>
  <main class="submit-page" :class="{ dragging }" @dragover="onDragOver" @dragleave.self="dragging = false" @drop="onDrop">
    <section class="submit-sheet" aria-label="日报登记">
      <header class="submit-head">
        <h1>日报登记</h1>
        <p v-if="today">{{ displayDate(today, { week: true }) }}</p>
      </header>

      <p v-if="loading" class="muted center">加载中…</p>

      <!-- 首次或切换：点姓名即可，无需下拉 -->
      <section v-else-if="!person || choosingName" class="who">
        <h2>请点选你的姓名</h2>
        <p class="muted">只需选一次，这台手机会记住</p>
        <div class="name-grid">
          <button v-for="entry in roster" :key="entry.id" type="button" :class="{ current: entry.id === personId }" @click="choose(entry.id)">{{ entry.name }}</button>
        </div>
        <button v-if="person" type="button" class="text-button" @click="choosingName = false">取消</button>
      </section>

      <template v-else>
        <div class="me-bar">
          <span class="avatar" aria-hidden="true">{{ person.name.slice(-2) }}</span>
          <strong>{{ person.name }}</strong>
          <button type="button" class="text-button" @click="choosingName = true">不是我？切换</button>
        </div>

        <nav class="week-strip" aria-label="最近 7 天">
          <button v-for="day in week" :key="day.date" type="button" :class="{ active: day.date === date, ok: day.count > 0, miss: day.listed && day.count === 0 && day.date !== today }" :disabled="busy" @click="pickDate(day.date)">
            <span>{{ day.date === today ? '今天' : weekday(day.date) }}</span>
            <b>{{ Number(day.date.slice(8)) }}</b>
            <i aria-hidden="true">{{ day.count > 0 ? '✓' : day.listed && day.date !== today ? '补' : '' }}</i>
          </button>
        </nav>
        <div class="week-foot">
          <span v-if="missedCount" class="miss-hint">最近 6 天有 {{ missedCount }} 天未提交，点日期可补交</span>
          <span v-else class="muted">点日期可查看或补交</span>
          <label class="other-date">
            更早日期
            <input type="date" :max="today" :value="date" :disabled="busy" @change="pickDate($event.target.value)" />
          </label>
        </div>

        <section class="status-card" :class="{ done }" role="status">
          <div class="status-icon" aria-hidden="true">{{ done ? '✓' : '!' }}</div>
          <div>
            <strong>{{ isToday ? '今日' : displayDate(date, { week: true }) }}{{ done ? '已提交' : '未提交' }}</strong>
            <span v-if="done">共 {{ images.length }} 张 · 最后提交 {{ lastTime }}</span>
            <span v-else>{{ isToday ? '上传日报截图即完成登记' : '上传截图即可补交' }}</span>
          </div>
        </section>

        <div v-if="images.length || queue.length" class="thumbs">
          <figure v-for="image in images" :key="image.id" class="thumb">
            <img v-if="imageKeys[image.id]" :src="`/api/image/${image.id}?key=${imageKeys[image.id]}`" alt="已提交截图" loading="lazy" />
            <span v-else class="thumb-placeholder">已提交<br />{{ timeOf(image.uploadedAt) }}</span>
            <button v-if="imageKeys[image.id]" type="button" class="thumb-remove" aria-label="删除这张截图" @click="removeImage(image)">×</button>
          </figure>
          <figure v-for="item in queue" :key="item.key" class="thumb uploading" :class="{ failed: item.error }">
            <img :src="item.preview" alt="正在上传" />
            <span v-if="!item.error" class="thumb-progress"><i :style="{ width: `${Math.round(item.progress * 100)}%` }"></i></span>
            <span v-else class="thumb-error">{{ item.error }}</span>
            <button v-if="item.error" type="button" class="thumb-remove" aria-label="移除" @click="dropQueued(item)">×</button>
          </figure>
        </div>

        <input ref="fileInput" class="sr-only" type="file" accept="image/*" multiple aria-label="选择截图" @change="acceptFiles($event.target.files)" />
        <button type="button" class="upload-button" :class="{ secondary: done }" :disabled="busy" @click="openPicker">
          <template v-if="busy">上传中…</template>
          <template v-else-if="done">＋ 再加一张</template>
          <template v-else>{{ isToday ? '上传今日日报截图' : `补交 ${displayDate(date)} 日报` }}</template>
        </button>
        <p class="muted center small">可一次选多张（最多 9 张）· 电脑上可直接粘贴或拖入截图</p>
      </template>

      <p v-if="error" class="error-text center" role="alert">{{ error }}</p>
    </section>
    <div v-if="toast" class="toast" role="status">{{ toast }}</div>
    <div v-if="dragging" class="drop-mask" aria-hidden="true">松开即可上传</div>
  </main>
</template>
