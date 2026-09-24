<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { api, addDays, copyText, displayDate, timeOf } from './api.js'
import ImageViewer from './ImageViewer.vue'
import StatsView from './StatsView.vue'
import RosterEditor from './RosterEditor.vue'

const TABS = [['board', '提交情况'], ['gallery', '截图浏览'], ['stats', '统计'], ['roster', '名单设置']]

const authorized = ref(false)
const loading = ref(true)
const password = ref('')
const loginBusy = ref(false)
const today = ref('')
const date = ref('')
const data = ref({ total: 0, submitted: 0, people: [] })
const tab = ref(TABS.some(([key]) => key === location.hash.slice(1)) ? location.hash.slice(1) : 'board')
const viewerIndex = ref(null)
const error = ref('')
const toast = ref('')
let refreshTimer
let toastTimer

const pending = computed(() => data.value.people.filter((person) => !person.submitted))
const done = computed(() => data.value.people.filter((person) => person.submitted).sort((a, b) => a.ordinal - b.ordinal))
const percent = computed(() => (data.value.total ? Math.round((data.value.submitted / data.value.total) * 100) : 0))
const isToday = computed(() => date.value === today.value)

watch(tab, (value) => { history.replaceState(null, '', `#${value}`) })
watch([pending, isToday, authorized], () => {
  document.title = authorized.value && isToday.value && data.value.total
    ? (pending.value.length ? `${pending.value.length}人未交 · 日报登记情况` : '全部已交 · 日报登记情况')
    : '日报登记情况'
})

function showToast(text) {
  toast.value = text
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = '' }, 2200)
}

async function loadDay() {
  if (!date.value) return
  const requested = date.value
  try {
    const result = await api(`/api/admin/day?date=${requested}`)
    if (requested !== date.value) return
    data.value = result
    error.value = ''
    if (viewerIndex.value !== null && viewerIndex.value >= done.value.length) viewerIndex.value = done.value.length ? done.value.length - 1 : null
  } catch (cause) {
    if (cause.status === 401) authorized.value = false
    error.value = cause.message
  }
}

async function loadMeta() {
  const result = await api('/api/meta')
  const wasToday = date.value === today.value || !date.value
  today.value = result.today
  if (wasToday) date.value = result.today
}

function setDate(value) {
  if (!value || value > today.value) return
  date.value = value
  viewerIndex.value = null
  loadDay()
}

function openDate(value) {
  setDate(value)
  tab.value = 'board'
}

async function login() {
  loginBusy.value = true
  error.value = ''
  try {
    await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: password.value }) })
    password.value = ''
    authorized.value = true
    await loadMeta()
    await loadDay()
  } catch (cause) { error.value = cause.message }
  finally { loginBusy.value = false }
}

async function logout() {
  await api('/api/admin/logout', { method: 'POST' }).catch(() => {})
  authorized.value = false
  viewerIndex.value = null
}

async function refresh() {
  if (!authorized.value || document.visibilityState !== 'visible') return
  try {
    await loadMeta()
    await loadDay()
  } catch { /* 网络恢复后再次读取 */ }
}

function openPerson(person) {
  const index = done.value.findIndex((entry) => entry.id === person.id)
  if (index >= 0) viewerIndex.value = index
}

async function copyPending() {
  if (!pending.value.length) return
  const text = `${displayDate(date.value)}日报还有 ${pending.value.length} 人未提交：${pending.value.map((person) => person.name).join('、')}\n提交入口：${location.origin}/`
  showToast((await copyText(text)) ? '未交名单已复制，可直接发到群里' : '复制失败')
}

async function deleteImage(image) {
  if (!window.confirm('确定删除这张截图？删除后该人员当天可能变为未提交。')) return
  try {
    await api(`/api/admin/image/${image.id}`, { method: 'DELETE' })
    showToast('已删除')
    await loadDay()
  } catch (cause) { showToast(cause.message) }
}

onMounted(async () => {
  document.addEventListener('visibilitychange', refresh)
  try {
    await loadMeta()
    await api('/api/admin/status')
    authorized.value = true
    await loadDay()
  } catch (cause) {
    if (cause.status !== 401) error.value = cause.message
  } finally { loading.value = false }
  refreshTimer = setInterval(refresh, 20_000)
})

onUnmounted(() => {
  document.removeEventListener('visibilitychange', refresh)
  clearInterval(refreshTimer)
  clearTimeout(toastTimer)
})
</script>

<template>
  <main class="admin-page">
    <form v-if="!loading && !authorized" class="login-form" @submit.prevent="login">
      <h1>管理员登录</h1>
      <input v-model="password" type="password" autocomplete="current-password" placeholder="密码" aria-label="管理员密码" required autofocus />
      <button type="submit" :disabled="loginBusy">{{ loginBusy ? '登录中…' : '进入' }}</button>
      <p class="muted small">登录后本设备 30 天内免登录</p>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    </form>

    <section v-if="authorized" class="admin-sheet" aria-label="日报登记情况">
      <header class="admin-head">
        <div class="admin-title">
          <h1>日报登记情况</h1>
          <div class="date-nav">
            <button type="button" aria-label="前一天" @click="setDate(addDays(date, -1))">‹</button>
            <label class="date-pick">
              <span>{{ displayDate(date, { week: true }) }}</span>
              <input type="date" :max="today" :value="date" aria-label="选择日期" @change="setDate($event.target.value)" />
            </label>
            <button type="button" aria-label="后一天" :disabled="isToday" @click="setDate(addDays(date, 1))">›</button>
            <button v-if="!isToday" type="button" class="today-link" @click="setDate(today)">回到今天</button>
          </div>
        </div>
        <div class="admin-summary">
          <div class="summary-numbers"><strong>{{ data.submitted }}</strong><span>/{{ data.total }} 已提交</span><em v-if="pending.length">{{ pending.length }} 人未交</em><em v-else-if="data.total" class="all-done">全部已交</em></div>
          <div class="progress" :aria-label="`完成 ${percent}%`"><i :style="{ width: `${percent}%` }"></i></div>
        </div>
      </header>

      <div class="admin-actions">
        <nav class="tabs" role="tablist">
          <button v-for="[key, label] in TABS" :key="key" type="button" role="tab" :aria-selected="tab === key" :class="{ active: tab === key }" @click="tab = key">{{ label }}</button>
        </nav>
        <div class="action-buttons">
          <button type="button" class="ghost-button" :disabled="!pending.length" @click="copyPending">复制未交名单</button>
          <a class="ghost-button" :class="{ disabled: !data.submitted }" :href="data.submitted ? `/api/admin/zip?date=${date}` : undefined" download>下载当天截图</a>
          <button type="button" class="text-button" @click="logout">退出</button>
        </div>
      </div>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>

      <div v-if="tab === 'board'" class="board">
        <section v-if="pending.length">
          <h2>未提交 <span>{{ pending.length }}</span></h2>
          <div class="people-grid">
            <span v-for="person in pending" :key="person.id" class="person-chip pending">
              <span class="person-number">{{ person.ordinal }}</span><span class="person-name">{{ person.name }}</span>
            </span>
          </div>
        </section>
        <section v-if="done.length">
          <h2>已提交 <span>{{ done.length }}</span><small>点姓名查看截图</small></h2>
          <div class="people-grid">
            <button v-for="person in done" :key="person.id" type="button" class="person-chip complete" :aria-label="`${person.name}，已提交，查看截图`" @click="openPerson(person)">
              <span class="person-number">{{ person.ordinal }}</span><span class="person-name">{{ person.name }}</span>
              <span class="person-meta">{{ person.images.length > 1 ? `${person.images.length}张 ` : '' }}{{ timeOf(person.images.at(-1).uploadedAt) }}</span>
            </button>
          </div>
        </section>
        <p v-if="!data.total" class="muted">这一天没有名单</p>
      </div>

      <div v-else-if="tab === 'gallery'" class="gallery">
        <p v-if="!done.length" class="muted">{{ displayDate(date) }}还没有人提交</p>
        <button v-for="(person, index) in done" :key="person.id" type="button" class="gallery-card" @click="viewerIndex = index">
          <img :src="`/api/admin/image/${person.images[0].id}`" :alt="`${person.name}的日报截图`" loading="lazy" />
          <span class="gallery-caption"><strong>{{ person.name }}</strong><span>{{ timeOf(person.images.at(-1).uploadedAt) }}{{ person.images.length > 1 ? ` · ${person.images.length}张` : '' }}</span></span>
        </button>
      </div>

      <StatsView v-else-if="tab === 'stats'" :today="today" @open-date="openDate" />
      <RosterEditor v-else-if="tab === 'roster'" @saved="loadDay" />
    </section>

    <ImageViewer v-if="viewerIndex !== null && done.length" v-model:index="viewerIndex" :people="done" :date="date" @close="viewerIndex = null" @delete="deleteImage" />
    <div v-if="toast" class="toast" role="status">{{ toast }}</div>
  </main>
</template>
