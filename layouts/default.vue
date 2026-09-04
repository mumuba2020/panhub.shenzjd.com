<template>
  <!-- 正常客户页面布局（2026-08-25 从 app.vue 搬移）：导航/公告/浮窗 -->
  <!-- admin 页面走 layouts/admin.vue（纯净后台），与本站完全解耦 -->
  <!-- 顶部导航：接入 site-navbar Web Component（头像登录依赖 wx-auth-sdk，脚本见下方 useHead） -->
  <ClientOnly>
    <site-navbar></site-navbar>
  </ClientOnly>

  <!-- 公告条（全站导航栏下方；关闭后不再显示，改公告内容时升级 key 版本号重新展示） -->
  <div v-if="showAnnouncement" class="announce-bar" role="status">
    <span class="announce-bar__text">
      📢 为防止失联，请关注<strong>右侧公众号</strong>，最新动态与服务通知将第一时间发布
    </span>
    <button class="announce-bar__close" type="button" @click="dismissAnnouncement" aria-label="关闭公告" title="关闭">✕</button>
  </div>

  <!-- 主内容区 -->
  <main class="main">
    <slot />
  </main>

  <!-- 页脚（隐私政策链接，2026-08-26 从 app.vue 移入：仅客户页显示，admin 后台不显示） -->
  <footer class="site-footer">
    <NuxtLink to="/privacy" class="footer-link">隐私政策</NuxtLink>
    <span class="footer-sep">·</span>
    <span class="footer-copy">© {{ new Date().getFullYear() }} PanHub</span>
  </footer>

  <!-- 广告解锁弹窗（floating-unlock WC，2026-09-04）：平时不显示，
       搜索配额超限（HTTP 402）时由 useUnlockAd 调 unlock() 弹出，
       用户扫码看激励视频广告后回调 {ticket, grant} 供验票放行 -->
  <ClientOnly>
    <floating-unlock
      api-base="https://wx-auth.shenzjd.com"
      site-id="panhub.shenzjd.com"
    ></floating-unlock>
  </ClientOnly>
</template>

<script setup lang="ts">
// 悬浮二维码 Web Component（公众号/赞赏码）：仅正常客户页面加载。
// admin 页面走 admin 布局，天然不加载本脚本（无 watch/isAdmin 判断，
// 布局隔离即隔离，2026-08-25 重构，修复 app.vue 全局 500）
// 顶部导航 site-navbar Web Component + 头像登录依赖 wx-auth-sdk。
// 顺序：先 wx-auth-sdk（silent 静默校验登录态、required:false 可选认证），再 site-navbar。
// （2026-08-29 起）该 UMD 全局单例（window.WxAuth，弹窗样式内联注入）是全站唯一
// SDK 实例：composables/useWxAuth.ts、useAdminApi.ts 复用它，不再打包 npm 版，
// SDK 发新版无需改本仓库依赖。搜索页 useWxAuth 会用强制认证配置重新 init。
useHead({
  script: [
    {
      src: "https://unpkg.com/wx-auth-sdk/dist/wx-auth.umd.js",
      body: true,
    },
    {
      innerHTML: `WxAuth.init({ silent: true, required: false })`,
      body: true,
    },
    {
      src: "https://unpkg.com/@wu529778790/site-navbar@latest/dist/site-navbar.wc.js",
      body: true,
    },
    {
      src: "https://unpkg.com/@wu529778790/floating-qr@latest/dist/floating-qr.wc.js",
      body: true,
    },
    {
      // 广告解锁弹窗（2026-09-04）：搜索配额超限时由 useUnlockAd 弹出，
      // 模板里的 <floating-unlock> 标签由该脚本注册为 Web Component
      src: "https://unpkg.com/@wu529778790/floating-unlock@latest/dist/floating-unlock.wc.js",
      body: true,
    },
  ],
});

const { loadSettings } = useSettings();

onMounted(() => {
  loadSettings();
  checkAnnouncement();
});

// 公告条（v4：防失联引导关注公众号。改公告内容时升级 key 版本号，让已关闭用户重新看到）
const ANNOUNCEMENT_KEY = "panhub:announcement-dismissed:v4";
const showAnnouncement = ref(false);
function checkAnnouncement() {
  try {
    if (localStorage.getItem(ANNOUNCEMENT_KEY)) return;
  } catch {}
  showAnnouncement.value = true;
}
function dismissAnnouncement() {
  showAnnouncement.value = false;
  try {
    localStorage.setItem(ANNOUNCEMENT_KEY, "1");
  } catch {}
}
</script>

<style scoped>
/* 顶部导航已接入 site-navbar Web Component，样式由组件自带，此处不再维护 */

/* 公告条（全宽细条，导航栏下方） */
.announce-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 7px 16px;
  background: linear-gradient(90deg, rgba(15, 118, 110, 0.08) 0%, rgba(59, 130, 246, 0.08) 100%);
  border-bottom: 1px solid rgba(15, 118, 110, 0.12);
  font-size: 13px;
  color: var(--text-secondary, #4b5563);
  line-height: 1.5;
  animation: barSlideIn 0.3s ease;
}
.announce-bar__text {
  text-align: center;
}
.announce-bar__text strong {
  color: var(--primary, #0f766e);
}
.announce-bar__close {
  flex-shrink: 0;
  background: none;
  border: none;
  font-size: 14px;
  color: var(--text-tertiary, #9ca3af);
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}
.announce-bar__close:hover {
  color: var(--text-secondary, #4b5563);
}
@keyframes barSlideIn {
  from {
    transform: translateY(-4px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

/* 页脚（隐私政策链接，2026-08-26 从 app.vue 移入：仅客户页布局显示，admin 后台不显示） */
.site-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 18px 16px 28px;
  font-size: 13px;
  color: var(--text-tertiary, #9ca3af);
}
.footer-link {
  color: var(--text-secondary, #6b7280);
  text-decoration: none;
}
.footer-link:hover {
  color: var(--accent, #2563eb);
}
.footer-sep {
  opacity: 0.5;
}
</style>
