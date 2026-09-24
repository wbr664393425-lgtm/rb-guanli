<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { api, imageDataUrl } from './api.js'

const roster = ref([])
const today = ref('')
const date = ref('')
const personId = ref('')
const submitted = ref(false)
const file = ref(null)
const preview = ref('')
const busy = ref(false)
const error = ref('')
const loading = ref(true)
const fileInput = ref(null)
let statusRequest = 0
let refreshTimer

function displayDate(value) {
  if (!value) return ''
  const [, month, day] = value.split('-')
  return `${Number(month)}月${Number(day)}日`
}

function rememberName() {
  try { localStorage.setItem('daily-report-person', personId.value) } catch { /* 无痕模式仍可提交 */ }
  loadStatus()
}

async function loadStatus() {
  const current = ++statusRequest
  submitted.value = false
  error.value = ''
  clearFile()
  if (!personId.value || !date.value) return
  try {
    const result = await api(`/api/my?personId=${encodeURIComponent(personId.value)}&date=${date.value}`)
    if (current === statusRequest) submitted.value = result.submitted
  } catch (cause) {
    if (current === statusRequest) error.value = cause.message
  }
}

function clearFile() {
  if (preview.value) URL.revokeObjectURL(preview.value)
  preview.value = ''
  file.value = null
  if (fileInput.value) fileInput.value.value = ''
}

function acceptFile(candidate) {
  if (!candidate) return
  error.value = ''
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(candidate.type)) {
    error.value = '请选择 PNG、JPG 或 WebP 截图'
    return
  }
  if (candidate.size > 6 * 1024 * 1024) {
    error.value = '图片不能超过 6 MB'
    return
  }
  clearFile()
  file.value = candidate
  preview.value = URL.createObjectURL(candidate)
}

function onDrop(event) {
  event.preventDefault()
  acceptFile(event.dataTransfer?.files?.[0])
}

function onPaste(event) {
  if (submitted.value) return
  const item = [...(event.clipboardData?.items || [])].find((entry) => entry.kind === 'file' && entry.type.startsWith('image/'))
  if (item) {
    event.preventDefault()
    acceptFile(item.getAsFile())
  }
}

async function submit() {
  error.value = ''
  if (!personId.value) { error.value = '请先选择姓名'; return }
  if (!file.value) { error.value = '请先选择截图'; return }
  busy.value = true
  try {
    const image = await imageDataUrl(file.value)
    await api('/api/upload', {
      method: 'POST',
      body: JSON.stringify({ personId: personId.value, date: date.value, image }),
    })
    submitted.value = true
    clearFile()
  } catch (cause) {
    error.value = cause.message
  } finally {
    busy.value = false
  }
}

async function refreshDay() {
  try {
    const result = await api('/api/meta')
    if (result.today !== today.value) {
      const wasToday = date.value === today.value
      today.value = result.today
      if (wasToday) { date.value = result.today; loadStatus() }
    }
  } catch { /* 网络恢复后再次读取 */ }
}

onMounted(async () => {
  window.addEventListener('paste', onPaste)
  try {
    const result = await api('/api/meta')
    roster.value = result.roster
    today.value = result.today
    date.value = result.today
    let saved = ''
    try { saved = localStorage.getItem('daily-report-person') || '' } catch { /* 忽略 */ }
    if (roster.value.some((person) => person.id === saved)) personId.value = saved
    await loadStatus()
  } catch (cause) {
    error.value = cause.message
  } finally {
    loading.value = false
  }
  refreshTimer = setInterval(refreshDay, 30_000)
})

onUnmounted(() => {
  window.removeEventListener('paste', onPaste)
  clearInterval(refreshTimer)
  clearFile()
})
</script>

<template>
  <main class="submit-page">
    <section class="submit-sheet" aria-label="日报登记">
      <header class="submit-head">
        <h1>日报登记</h1>
        <label class="date-control">
          <span class="sr-only">归档日期</span>
          <input v-model="date" type="date" :max="today" :disabled="loading" @change="loadStatus" />
          <span class="date-display">{{ displayDate(date) }}</span>
        </label>
      </header>

      <label class="name-row">
        <span>姓名</span>
        <span class="name-select-wrap">
          <select v-model="personId" :disabled="loading" aria-label="选择姓名" @change="rememberName">
            <option value="">请选择姓名</option>
            <option v-for="person in roster" :key="person.id" :value="person.id">{{ person.name }}</option>
          </select>
          <span aria-hidden="true">⌄</span>
        </span>
      </label>

      <div v-if="submitted" class="submitted-state" role="status"><span aria-hidden="true">✓</span> 已提交</div>
      <template v-else>
        <input ref="fileInput" class="sr-only" type="file" accept="image/png,image/jpeg,image/webp" aria-label="选择截图" @change="acceptFile($event.target.files?.[0])" />
        <div class="upload-zone" role="button" tabindex="0" aria-label="选择、拖入或粘贴截图" @click="fileInput?.click()" @keydown.enter.prevent="fileInput?.click()" @keydown.space.prevent="fileInput?.click()" @dragover.prevent @drop="onDrop">
          <span class="upload-icon" aria-hidden="true">▧</span>
          <span class="upload-label">{{ file ? file.name : '选择 / 拖入 / 粘贴截图' }}</span>
          <img v-if="preview" :src="preview" alt="已选截图预览" class="upload-preview" />
        </div>
        <button class="submit-button" type="button" :disabled="busy || loading" @click="submit">{{ busy ? '提交中…' : '提交' }}</button>
      </template>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    </section>
  </main>
</template>
