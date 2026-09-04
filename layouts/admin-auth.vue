<template>
  <!-- 管理后台登录拦截页布局：极简居中壳，不渲染侧栏菜单（未登录不该看到后台结构） -->
  <div class="admin-auth-shell">
    <div class="admin-auth-backdrop" aria-hidden="true"></div>
    <main class="admin-auth-main">
      <slot />
    </main>
  </div>
</template>

<script setup lang="ts">
import "tdesign-vue-next/es/style/index.css";
import "~/assets/css/admin-shared.css";
import { useTDesignDark } from "~/composables/useTDesignDark";

/**
 * 登录拦截页布局（2026-09-01）
 * 样式引入与深色同步逻辑与 layouts/admin.vue 保持一致（useTDesignDark）。
 */
useTDesignDark();
</script>

<style>
.admin-auth-shell {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  /* 不透明页面底色：隔绝客户端 body 的渐变背景 */
  background: var(--td-bg-color-page, #f4f6f9);
  position: relative;
  overflow: hidden;
}

/* 顶部淡光晕（与全站 bg-decoration 同语言） */
.admin-auth-backdrop {
  position: absolute;
  top: -20%;
  left: 50%;
  transform: translateX(-50%);
  width: 900px;
  height: 480px;
  background: radial-gradient(ellipse at center, var(--primary-glow, rgba(37, 99, 235, 0.12)), transparent 70%);
  pointer-events: none;
}

.admin-auth-main {
  position: relative;
  width: 100%;
  max-width: 420px;
}
</style>
