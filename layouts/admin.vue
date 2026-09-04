<template>
  <!-- 鉴权门（未 ok 时不渲染任何后台结构，全屏单一状态，杜绝"菜单在上、检测在下"的割裂） -->
  <div v-if="shellState !== 'ok'" class="admin-gate">
    <div v-if="shellState === 'checking'" class="admin-gate-card">
      <t-loading text="正在检测登录状态…" size="small" />
    </div>

    <div v-else-if="shellState === 'error'" class="admin-gate-card admin-gate-card--alert">
      <t-alert theme="error">
        <template #message>
          <strong>登录状态检测失败</strong>（{{ probeError || "网络异常" }}）
        </template>
      </t-alert>
      <t-button block class="admin-gate-btn" @click="retry">重试</t-button>
    </div>

    <div v-else-if="shellState === 'no-admin'" class="admin-gate-card admin-gate-card--alert">
      <t-alert theme="error">
        <template #message>
          <strong>无权限访问</strong>：当前账号不是管理员。<br />
          请在 wx-auth 后台将该账号标记为管理员后重试。
        </template>
      </t-alert>
      <t-button block class="admin-gate-btn" @click="retry">重新检测</t-button>
    </div>
  </div>

  <!-- 后台外壳（鉴权通过后一次性渲染：侧栏菜单 + 内容区） -->
  <div v-else class="admin-shell">
    <!-- 遮罩（移动端抽屉打开时） -->
    <div v-if="menuOpen" class="admin-mask" @click="menuOpen = false" />

    <!-- 侧栏：普通 flex 容器 + t-menu（自包含组件；不用 t-aside——其
         "首帧渲染为空、onMounted 再补画 + onUnmounted 反转共享标志"的机制
         与鉴权切换叠加会导致菜单时有时无，2026-09-02 移除） -->
    <div :class="['admin-sidebar', { open: menuOpen }]">
      <t-menu :value="activeKey" @change="(k: any) => setActive(String(k))">
        <template #logo>
          <NuxtLink to="/" class="admin-brand" title="返回首页">
            <span class="admin-brand-badge">
              <img
                src="https://cdn.jsdmirror.com/gh/wu529778790/img.shenzjd.com@master/blog/imgx-20260828-151509-5bk7.svg"
                alt="PanHub"
                class="admin-brand-logo"
              />
            </span>
            <span class="admin-brand-name">PanHub 管理后台</span>
          </NuxtLink>
        </template>

        <template v-for="group in MENU_GROUPS" :key="group.label ?? ''">
          <t-menu-group v-if="group.label" :title="group.label" />
          <t-menu-item v-for="item in group.items" :key="item.key" :value="item.key">
            <template #icon>
              <svg class="admin-menu-icon" viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path :d="item.icon" />
              </svg>
            </template>
            {{ item.label }}
          </t-menu-item>
        </template>
      </t-menu>
    </div>

    <!-- 内容区：面包屑 + 面板 -->
    <div class="admin-main">
      <main class="admin-content">
        <t-breadcrumb class="admin-crumb">
          <t-breadcrumb-item to="/">PanHub</t-breadcrumb-item>
          <t-breadcrumb-item>{{ currentLabel }}</t-breadcrumb-item>
        </t-breadcrumb>

        <slot />
      </main>
    </div>

    <!-- 移动端：悬浮汉堡开抽屉 -->
    <button
      v-if="isMobile && !menuOpen"
      type="button"
      class="admin-burger-fab"
      aria-label="打开菜单"
      @click="menuOpen = true">☰</button>
  </div>
</template>

<script setup lang="ts">
import { ADMIN_NAV_KEY } from "~/utils/adminKeys";
import "tdesign-vue-next/es/style/index.css";
import "~/assets/css/admin-shared.css";
import { useTDesignDark } from "~/composables/useTDesignDark";
import { useAdminApi } from "~/composables/useAdminApi";

/**
 * 管理后台布局（2026-09-02 流程定稿：cookie 判断 → check → userinfo → 进后台）
 *
 * 整套流程（访问 /admin 时）：
 *   1. 没有 wxauth-token cookie → 直接跳 /admin/login，让他登录（不发请求、不碰 SDK）
 *   2. 有 cookie → GET /api/admin/auth 一次出结论：
 *      ├─ 401（token 无效/过期）→ 跳登录页
 *      ├─ 403（非管理员）      → 全屏"无权限"提示
 *      ├─ 200（是管理员）      → 直接进后台（一次性渲染侧栏 + 内容区）
 *      └─ 网络异常             → 全屏"检测失败 + 重试"
 *
 * 鉴权状态为全局单例（useAdminApi 模块级 ref）：登录后任何面板接口 401
 * 都会触发本布局统一跳登录页。
 *
 * 深色模式：TDesign 用 <html theme-mode="dark"> 属性（useTDesignDark 同步），
 * 自定义外壳 CSS 走全局 token（.dark class），两者同源（prefers-color-scheme）。
 */
interface AdminMenuItem {
  key: string;
  label: string;
  icon: string; // SVG path
}
interface AdminMenuGroup {
  label?: string;
  items: AdminMenuItem[];
}

/** 菜单分组（新增功能往这里加；页面面板须与 key 对应渲染） */
const MENU_GROUPS: AdminMenuGroup[] = [
  {
    label: "概览",
    items: [
      { key: "overview", label: "控制台", icon: "M2 9.5 9 3.5l7 6-.8 1.1h-1v5H10v-3.5H8V15.6H3.8v-5h-.8L3 9.5Z" },
    ],
  },
  {
    label: "管理",
    items: [
      { key: "channels", label: "搜索源管理", icon: "M2 5.5h14M2 12.5h14M5.5 3v5M12.5 10v5M5 5.5h.01M13 12.5h.01" },
      { key: "search-log", label: "搜索记录", icon: "M3 3h12M3 8h12M3 13h12M6 5h.01M6 10h.01M6 15h.01" },
    ],
  },
  {
    label: "防护",
    items: [
      { key: "blacklist", label: "IP 黑名单", icon: "M3 6h12M3 12h12M9 5v2M9 11v2" },
    ],
  },
];

const route = useRoute();
const { authStatus, probeError, checkAdminAuth } = useAdminApi();
useTDesignDark();

const activeKey = ref<string>("overview");
const menuOpen = ref(false);
const isMobile = ref(false);

/** 鉴权门外壳状态（no-login 时正跳转登录页，保持全屏检测态避免空白帧） */
const shellState = computed<"checking" | "ok" | "error" | "no-admin">(() => {
  const s = authStatus.value;
  return s === "no-login" ? "checking" : s;
});

/** 当前激活菜单项（面包屑） */
const currentLabel = computed(
  () => MENU_GROUPS.flatMap((g) => g.items).find((m) => m.key === activeKey.value)?.label || "管理后台",
);

function setActive(key: string) {
  activeKey.value = key;
  menuOpen.value = false;
}

// 鉴权结论（共享单例状态）→ 统一反应：
// no-login（无 cookie / token 失效）→ 跳登录页。
// 任何面板接口 401/403 都会写入同一份状态，此处自动响应。
watch(authStatus, (s) => {
  if (s === "no-login") goLogin();
});

async function retry() {
  await checkAdminAuth();
}

function goLogin() {
  navigateTo({ path: "/admin/login", query: { redirect: route.fullPath } });
}

function onResize() {
  isMobile.value = typeof window !== "undefined" && window.innerWidth < 900;
  if (!isMobile.value) menuOpen.value = false;
}

onMounted(async () => {
  onResize();
  window.addEventListener("resize", onResize);
  // 鉴权门：无 cookie → 直接跳登录；有 cookie → /api/admin/auth 一次出结论
  await checkAdminAuth();
});
onBeforeUnmount(() => window.removeEventListener("resize", onResize));

// 提供给页面：切换菜单
provide(ADMIN_NAV_KEY, { activeKey, setActive });
</script>

<style>
/* 注：admin-shared.css 提供作用域 token；t-* 组件配色全部走 TDesign token */

/* ===== 鉴权门（全屏单一状态） ===== */
.admin-gate {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--td-bg-color-page, #f4f6f9);
}
.admin-gate-card {
  width: 100%;
  max-width: 420px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 28px;
  border-radius: 14px;
}
.admin-gate-card--alert {
  background: var(--bg-primary, #ffffff);
  border: 1px solid var(--border-light, #e8ecf0);
}
.admin-gate-btn { margin-top: 2px; }

/* ===== 外壳（普通 flex 结构；t-aside 已移除，见模板内注释） ===== */
.admin-shell {
  height: 100vh;
  overflow: hidden;
  display: flex;
  /* 不透明页面底色：隔绝客户端 body 的渐变背景（--td-bg-color-page
     随 theme-mode 深浅色自动切换） */
  background: var(--td-bg-color-page, #f4f6f9);
}

/* 遮罩（移动端抽屉） */
.admin-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 120;
}

/* ===== 侧栏 ===== */
.admin-sidebar {
  width: 248px;
  flex-shrink: 0;
  height: 100vh;
  overflow-y: auto;
  background: var(--td-bg-color-container, #ffffff);
  border-right: 1px solid var(--td-component-border, var(--border-light, #e8ecf0));
}
.admin-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  text-decoration: none;
  color: var(--td-text-color-primary, #1f2937);
}
.admin-brand-badge {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: linear-gradient(135deg, #2563eb, #2151c7);
  display: grid;
  place-items: center;
  flex-shrink: 0;
  box-shadow: 0 2px 6px rgba(37, 99, 235, 0.25);
  overflow: hidden;
}
.admin-brand-logo {
  width: 30px;
  height: 30px;
  display: block;
  object-fit: cover;
}
.admin-brand-name {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.3px;
  white-space: nowrap;
}
.admin-menu-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}
/* 菜单撑满侧栏高度 */
.admin-sidebar .t-default-menu {
  height: 100%;
}

/* ===== 内容区（唯一滚动区） ===== */
.admin-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.admin-content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 24px 32px 56px;
}
.admin-crumb {
  margin-bottom: 20px;
}

/* ===== 窄屏适配 ===== */
@media (max-width: 900px) {
  .admin-sidebar {
    position: fixed;
    top: 0;
    bottom: 0;
    left: 0;
    z-index: 130;
    width: 240px;
    transform: translateX(-100%);
    transition: transform 0.25s ease;
    box-shadow: var(--shadow-xl, 0 20px 25px -5px rgba(0, 0, 0, 0.1));
  }
  .admin-sidebar.open { transform: translateX(0); }
  .admin-content { padding: 16px 14px 40px; }
  /* 悬浮汉堡按钮开抽屉 */
  .admin-burger-fab {
    position: fixed;
    top: 12px;
    left: 12px;
    z-index: 110;
    width: 40px;
    height: 40px;
    border: none;
    border-radius: 10px;
    background: var(--bg-primary, #ffffff);
    color: var(--text-secondary, #475569);
    font-size: 20px;
    box-shadow: var(--shadow-md, 0 4px 6px -1px rgba(0, 0, 0, 0.1));
    cursor: pointer;
  }
}
</style>
