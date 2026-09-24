<script setup>
import { computed, ref, watch } from 'vue'
import { api, addDays, weekday } from './api.js'

const props = defineProps({ today: { type: String, required: true } })
const emit = defineEmits(['open-date'])

const span = ref('7')
const data = ref({ dates: [], people: [] })
const loading = ref(false)
const error = ref('')
const onlyMissed = ref(false)

const rangeOf = computed(() => {
  const today = props.today
  if (span.value === 'month') return { from: `${today.slice(0, 8)}01`, to: today }
  if (span.value === 'last-month') {
    const lastDay = addDays(`${today.slice(0, 8)}01`, -1)
    return { from: `${lastDay.slice(0, 8)}01`, to: lastDay }
  }
  return { from: addDays(today, -(Number(span.value) - 1)), to: today }
})

const rows = computed(() => {
  const list = data.value.people.map((person) => {
    const onList = data.value.dates.filter((date) => date in person.days)
    const done = onList.filter((date) => person.days[date] > 0).length
    return { ...person, done, missed: onList.length - done }
  })
  const filtered = onlyMissed.value ? list.filter((row) => row.missed > 0) : list
  return onlyMissed.value ? [...filtered].sort((a, b) => b.missed - a.missed) : filtered
})

const daily = computed(() => data.value.dates.map((date) => {
  const members = data.value.people.filter((person) => date in person.days)
  return { date, total: members.length, done: members.filter((person) => person.days[date] > 0).length }
}))

async function load() {
  if (!props.today) return
  loading.value = true
  error.value = ''
  try { data.value = await api(`/api/admin/range?from=${rangeOf.value.from}&to=${rangeOf.value.to}`) }
  catch (cause) { error.value = cause.message }
  finally { loading.value = false }
}

function exportCsv() {
  const header = ['姓名', ...data.value.dates, '已交天数', '缺交天数']
  const lines = [header, ...rows.value.map((row) => [
    row.name,
    ...data.value.dates.map((date) => (date in row.days ? (row.days[date] > 0 ? '✓' : '未交') : '')),
    row.done, row.missed,
  ])]
  const csv = '﻿' + lines.map((line) => line.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\r\n')
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  link.download = `日报统计-${rangeOf.value.from}至${rangeOf.value.to}.csv`
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 1000)
}

watch([rangeOf, () => props.today], load, { immediate: true })
defineExpose({ load })
</script>

<template>
  <section class="stats">
    <div class="toolbar">
      <div class="segmented" role="group" aria-label="统计范围">
        <button v-for="option in [['7', '近7天'], ['14', '近14天'], ['30', '近30天'], ['month', '本月'], ['last-month', '上月']]" :key="option[0]" type="button" :class="{ active: span === option[0] }" @click="span = option[0]">{{ option[1] }}</button>
      </div>
      <label class="check-label"><input v-model="onlyMissed" type="checkbox" /> 只看有缺交的人</label>
      <button type="button" class="ghost-button" :disabled="!rows.length" @click="exportCsv">导出 Excel(CSV)</button>
    </div>
    <p v-if="error" class="error-text">{{ error }}</p>
    <div class="stats-scroll" :class="{ loading }">
      <table class="stats-table">
        <thead>
          <tr>
            <th class="sticky">姓名</th>
            <th v-for="day in daily" :key="day.date">
              <button type="button" title="查看这一天" @click="emit('open-date', day.date)">
                <span>{{ Number(day.date.slice(5, 7)) }}/{{ Number(day.date.slice(8)) }}</span>
                <small>{{ weekday(day.date).slice(1) }}</small>
              </button>
            </th>
            <th>已交</th>
            <th>缺交</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id">
            <th class="sticky">{{ row.name }}<small v-if="!row.active">（已移出）</small></th>
            <td v-for="date in data.dates" :key="date" :class="date in row.days ? (row.days[date] > 0 ? 'ok' : 'miss') : 'none'">
              {{ date in row.days ? (row.days[date] > 0 ? '✓' : '✗') : '' }}
            </td>
            <td class="num">{{ row.done }}</td>
            <td class="num" :class="{ bad: row.missed > 0 }">{{ row.missed }}</td>
          </tr>
          <tr v-if="!rows.length && !loading"><td :colspan="data.dates.length + 3" class="empty">{{ onlyMissed ? '这段时间没有人缺交 🎉' : '暂无数据' }}</td></tr>
        </tbody>
        <tfoot>
          <tr>
            <th class="sticky">提交人数</th>
            <td v-for="day in daily" :key="day.date" class="num">{{ day.total ? `${day.done}/${day.total}` : '' }}</td>
            <td></td><td></td>
          </tr>
        </tfoot>
      </table>
    </div>
    <p class="muted small">空白格表示当天没有该人员的名单记录（系统未启用或当时不在名单中）。点击日期可查看当天截图。</p>
  </section>
</template>
