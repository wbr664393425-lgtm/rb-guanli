<script setup>
import SubmitPage from './SubmitPage.vue'
import AdminPage from './AdminPage.vue'

const isAdmin = window.location.pathname.startsWith('/admin')
document.title = isAdmin ? '日报登记情况' : '日报登记'
</script>

<template>
  <AdminPage v-if="isAdmin" />
  <SubmitPage v-else />
</template>
