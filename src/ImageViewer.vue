<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { displayDate, timeOf } from './api.js'

const props = defineProps({
  people: { type: Array, required: true },
  index: { type: Number, required: true },
  date: { type: String, required: true },
})
const emit = defineEmits(['update:index', 'close', 'delete'])

const body = ref(null)
const person = computed(() => props.people[props.index])
let touchX = null
let touchY = null

function go(step) {
  const next = props.index + step
  if (next >= 0 && next < props.people.length) emit('update:index', next)
}

function onKeydown(event) {
  if (event.key === 'Escape') emit('close')
  else if (event.key === 'ArrowLeft') go(-1)
  else if (event.key === 'ArrowRight') go(1)
}

function onTouchStart(event) {
  touchX = event.touches[0].clientX
  touchY = event.touches[0].clientY
}

function onTouchEnd(event) {
  if (touchX === null) return
  const dx = event.changedTouches[0].clientX - touchX
  const dy = event.changedTouches[0].clientY - touchY
  touchX = null
  if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1)
}

// 切换人员时回到顶部，并预加载下一位的截图
watch(() => props.index, () => {
  body.value?.scrollTo({ top: 0 })
  props.people[props.index + 1]?.images.forEach((image) => { new Image().src = `/api/admin/image/${image.id}` })
}, { immediate: true })

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  document.body.style.overflow = 'hidden'
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  document.body.style.overflow = ''
})
</script>

<template>
  <div v-if="person" class="viewer" role="dialog" aria-modal="true" :aria-label="`${person.name}的日报截图`" @touchstart.passive="onTouchStart" @touchend="onTouchEnd">
    <header class="viewer-bar">
      <button type="button" class="viewer-nav" :disabled="index === 0" aria-label="上一位" @click="go(-1)">‹</button>
      <div class="viewer-title">
        <strong>{{ person.name }}</strong>
        <span>{{ displayDate(date) }} · {{ timeOf(person.images.at(-1)?.uploadedAt) }} · {{ person.images.length }} 张 · 第 {{ index + 1 }}/{{ people.length }} 位</span>
      </div>
      <button type="button" class="viewer-nav" :disabled="index === people.length - 1" aria-label="下一位" @click="go(1)">›</button>
      <button type="button" class="viewer-close" aria-label="关闭" @click="emit('close')">×</button>
    </header>
    <div ref="body" class="viewer-body" @click.self="emit('close')">
      <figure v-for="(image, imageIndex) in person.images" :key="image.id">
        <img :src="`/api/admin/image/${image.id}`" :alt="`${person.name}的日报截图 ${imageIndex + 1}`" />
        <figcaption>
          <span>第 {{ imageIndex + 1 }} 张 · {{ timeOf(image.uploadedAt) }}</span>
          <a :href="`/api/admin/image/${image.id}`" target="_blank" rel="noopener">原图</a>
          <button type="button" @click="emit('delete', image)">删除</button>
        </figcaption>
      </figure>
      <p class="viewer-tip">← → 键或左右滑动切换人员，Esc 关闭</p>
    </div>
  </div>
</template>
