<script setup>
import { computed, onMounted, ref } from 'vue'
import { api, copyText } from './api.js'

const emit = defineEmits(['saved'])
const text = ref('')
const original = ref('')
const busy = ref(false)
const message = ref('')
const error = ref('')

const names = computed(() => text.value.split(/[\n,，、;；\s]+/).map((name) => name.trim()).filter(Boolean))
const dirty = computed(() => names.value.join('\n') !== original.value)
const origin = window.location.origin

async function load() {
  const result = await api('/api/admin/roster')
  original.value = result.roster.map((person) => person.name).join('\n')
  text.value = original.value
}

async function save() {
  error.value = ''
  message.value = ''
  const before = new Set(original.value.split('\n'))
  const after = new Set(names.value)
  const removed = [...before].filter((name) => name && !after.has(name))
  if (removed.length && !window.confirm(`将从名单移出：${removed.join('、')}\n历史记录会保留。确定保存？`)) return
  busy.value = true
  try {
    const result = await api('/api/admin/roster', { method: 'PUT', body: JSON.stringify({ names: names.value }) })
    original.value = result.roster.map((person) => person.name).join('\n')
    text.value = original.value
    message.value = `已保存，共 ${result.roster.length} 人`
    emit('saved')
  } catch (cause) { error.value = cause.message }
  finally { busy.value = false }
}

async function copy(value) {
  message.value = (await copyText(value)) ? '链接已复制' : '复制失败，请手动复制'
}

onMounted(() => load().catch((cause) => { error.value = cause.message }))
</script>

<template>
  <section class="roster-editor">
    <div class="link-card">
      <div>
        <strong>员工填报链接</strong>
        <code>{{ origin }}/</code>
      </div>
      <button type="button" class="ghost-button" @click="copy(`${origin}/`)">复制链接</button>
    </div>

    <label for="roster-text"><strong>人员名单</strong>（每行一个姓名，顺序即编号顺序；共 {{ names.length }} 人）</label>
    <textarea id="roster-text" v-model="text" rows="16" spellcheck="false"></textarea>
    <p class="muted small">新增姓名今天起生效；移出的人员今天未提交则从今天名单去掉，历史记录和截图保留。改名相当于移出旧名、新增新名。</p>
    <div class="roster-actions">
      <button type="button" class="primary-button" :disabled="busy || !dirty" @click="save">{{ busy ? '保存中…' : '保存名单' }}</button>
      <button v-if="dirty" type="button" class="ghost-button" @click="text = original">撤销修改</button>
      <span v-if="message" class="ok-text">{{ message }}</span>
      <span v-if="error" class="error-text">{{ error }}</span>
    </div>
  </section>
</template>
