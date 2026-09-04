<template>
  <div class="layout">
    <!-- 背景装饰 -->
    <div class="bg-decoration">
      <div class="blob blob-1"></div>
      <div class="blob blob-2"></div>
      <div class="blob blob-3"></div>
    </div>

    <!-- 布局切换（2026-08-25 重构）：正常客户页面 → layouts/default.vue
         （导航/公告/浮窗）；admin 页 → layouts/admin.vue（纯净后台） -->
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>

    <!-- Toast 通知（全站） -->
    <div v-if="toast.show" class="toast" :class="toast.type" role="status" aria-live="polite">
      {{ toast.message }}
    </div>
  </div>
</template>

<script setup lang="ts">
// 全站骨架：暗色模式 CSS + 阻塞脚本（普通 useHead，⚠️ 不要用函数式工厂——
// 曾触发 unhead "Cannot access 'h' before initialization" SSR 时序错误）
// 主题纯跟随系统（prefers-color-scheme），首屏即时生效，无需等待 JS
useHead({
  link: [{ rel: "stylesheet", href: "/css/dark-mode.css" }],
  script: [
    {
      innerHTML: `(function(){if(window.matchMedia&&window.matchMedia('(prefers-color-scheme:dark)').matches)document.documentElement.classList.add('dark')})();`,
    },
  ],
});

const { toast } = useToast();
const { init: initDarkMode } = useDarkMode();

onMounted(() => {
  initDarkMode();
});
</script>

<style>
@import '~/assets/css/global.css';

/* 主内容区（default/admin 两个布局共用） */
.main {
  flex: 1;
  width: 100%;
  max-width: 1100px;
  margin: 0 auto;
  padding: 24px;
  animation: fadeIn 0.5s ease;
}

@media (max-width: 900px) {
  .main {
    padding: 16px;
  }
}
</style>

<style scoped>
/* 主布局 */
.layout {
  height: 100vh;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow-x: hidden;
  overflow-y: auto;
}

/* 背景装饰光斑：径向渐变模拟软光斑（2026-09-04 滚动性能优化）。
   此前 filter: blur(48px) 的图层常驻动画，叠加页面各处 backdrop-filter
   毛玻璃卡片 = 每帧强制重新采样模糊，是滚动掉帧主因之一；
   改径向渐变后动画只是合成器上的 transform 变换，零重绘成本 */
.bg-decoration {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: -1;
  overflow: hidden;
}

.blob {
  position: absolute;
  border-radius: 50%;
  opacity: 0.28;
  animation: blobFloat 8s ease-in-out infinite;
}

.blob-1 {
  width: 400px;
  height: 400px;
  background: radial-gradient(circle at 40% 40%, #14b8a6 0%, #0f766e 45%, transparent 72%);
  top: -100px;
  left: -100px;
  animation-delay: 0s;
}

.blob-2 {
  width: 300px;
  height: 300px;
  background: radial-gradient(circle at 40% 40%, #fb7185 0%, #f59e0b 45%, transparent 72%);
  bottom: -50px;
  right: -50px;
  animation-delay: 2s;
}

.blob-3 {
  width: 250px;
  height: 250px;
  background: radial-gradient(circle at 40% 40%, #14b8a6 0%, #0ea5e9 45%, transparent 72%);
  top: 50%;
  left: 70%;
  animation-delay: 4s;
}

/* Toast 通知 */
.toast {
  position: fixed;
  top: 80px;
  right: 24px;
  padding: 12px 20px;
  border-radius: var(--radius-md);
  background: var(--bg-primary);
  box-shadow: var(--shadow-xl);
  border: 1px solid var(--border-light);
  font-weight: 500;
  z-index: 1000;
  animation: slideInRight 0.3s ease;
  display: flex;
  align-items: center;
  gap: 8px;
}

.toast::before {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}

.toast.info {
  color: var(--primary);
  border-left: 4px solid var(--primary);
}

.toast.success {
  color: var(--success);
  border-left: 4px solid var(--success);
}

.toast.error {
  color: var(--error);
  border-left: 4px solid var(--error);
}

/* 移动端优化 */
@media (max-width: 900px) {
  .toast {
    right: 16px;
    left: 16px;
    top: 70px;
  }
}

/* 减少动画模式支持 */
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }

  .blob {
    animation: none;
  }
}
</style>
