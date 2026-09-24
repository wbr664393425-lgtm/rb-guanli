<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { api } from './api.js'

const authorized = ref(false)
const loading = ref(true)
const password = ref('')
const loginBusy = ref(false)
const today = ref('')
const date = ref('')
const data = ref({ total: 0, submitted: 0, people: [] })
const selected = ref(null)
const error = ref('')
let refreshTimer

function displayDate(value) {
  if (!value) return ''
  const [, month, day] = value.split('-')
  return `${Number(month)}月${Number(day)}日`
}

async function loadDay() {
  if (!date.value) return
  error.value = ''
  try { data.value = await api(`/api/admin/day?date=${date.value}`) }
  catch (cause) {
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
  await api('/api/admin/logout', { method: 'POST' })
  authorized.value = false
  selected.value = null
}

async function refresh() {
  if (!authorized.value) return
  try {
    await loadMeta()
    await loadDay()
  } catch { /* 网络恢复后再次读取 */ }
}

function onKeydown(event) {
  if (event.key === 'Escape') selected.value = null
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  try {
    await loadMeta()
    await api('/api/admin/status')
    authorized.value = true
    await loadDay()
  } catch (cause) {
    if (cause.status !== 401) error.value = cause.message
  } finally { loading.value = false }
  refreshTimer = setInterval(refresh, 30_000)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  clearInterval(refreshTimer)
})
</script>

<template>
  <main class="admin-page">
    <form v-if="!loading && !authorized" class="login-form" @submit.prevent="login">
      <h1>管理员登录</h1>
      <input v-model="password" type="password" autocomplete="current-password" placeholder="密码" aria-label="管理员密码" required />
      <button type="submit" :disabled="loginBusy">{{ loginBusy ? '登录中…' : '进入' }}</button>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    </form>

    <section v-if="authorized" class="admin-sheet" aria-label="日报登记情况">
      <header class="admin-head">
        <div>
          <h1>日报登记情况</h1>
          <label class="admin-date">
            <span class="sr-only">查看日期</span>
            <input v-model="date" type="date" :max="today" @change="loadDay" />
            <span>{{ displayDate(date) }}</span>
          </label>
        </div>
        <div class="admin-head-right">
          <strong>{{ data.submitted }}/{{ data.total }}</strong><span>已提交</span>
          <button type="button" class="logout" @click="logout">退出</button>
        </div>
      </header>

      <div class="people-grid" aria-live="polite">
        <template v-for="(person, index) in data.people" :key="person.id">
          <button v-if="person.submitted" type="button" class="person-chip complete" :aria-label="`${person.name}，已提交，查看截图`" @click="selected = person">
            <span class="person-number">{{ index + 1 }}</span><span class="person-name">{{ person.name }}</span><span class="check" aria-hidden="true">✓</span>
          </button>
          <span v-else class="person-chip pending" :aria-label="`${person.name}，未提交`">
            <span class="person-number">{{ index + 1 }}</span><span class="person-name">{{ person.name }}</span>
          </span>
        </template>
      </div>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    </section>

    <div v-if="selected" class="viewer-backdrop" @click.self="selected = null">
      <section class="viewer" role="dialog" aria-modal="true" :aria-label="`${selected.name}的日报截图`">
        <header><strong>{{ selected.name }} · {{ displayDate(date) }}</strong><button type="button" aria-label="关闭截图" @click="selected = null">×</button></header>
        <img :src="`/api/admin/image/${selected.imageId}`" :alt="`${selected.name}的日报截图`" />
      </section>
    </div>
  </main>
</template>
