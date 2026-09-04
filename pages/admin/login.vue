<template>
  <div class="login-page">
    <t-card bordered class="login-card">
      <!-- 品牌区 -->
      <div class="login-brand">
        <span class="login-brand-badge">
          <img
            src="https://cdn.jsdmirror.com/gh/wu529778790/img.shenzjd.com@master/blog/imgx-20260828-151509-5bk7.svg"
            alt="PanHub"
            class="login-brand-logo"
          />
        </span>
        <div class="login-brand-text">
          <h1 class="login-title">PanHub 管理后台</h1>
          <p class="login-subtitle">仅限管理员访问，请先完成微信公众号登录</p>
        </div>
      </div>

      <t-divider />

      <!-- 状态区 -->
      <div v-if="state === 'checking'" class="login-state">
        <t-loading text="正在检测登录状态…" size="small" />
      </div>

      <template v-else-if="state === 'need-login' || state === 'logging-in'">
        <t-button
          theme="primary"
          size="large"
          block
          class="login-btn"
          :loading="state === 'logging-in'"
          @click="startLogin">
          微信登录
        </t-button>
      </template>

      <template v-else-if="state === 'no-admin'">
        <t-alert theme="error" class="login-alert">
          <template #message>
            当前账号已登录，但未被标记为管理员。<br />
            请在 wx-auth 后台为该账号开启管理员权限后重试。
          </template>
        </t-alert>
        <t-button variant="outline" block class="login-btn" @click="boot">重新检测</t-button>
      </template>

      <template v-else-if="state === 'error'">
        <t-alert theme="error" :message="errorMsg || '登录状态检测失败，请重试。'" class="login-alert" />
        <t-button variant="outline" block class="login-btn" @click="boot">重试</t-button>
      </template>

      <div v-else-if="state === 'redirecting'" class="login-state">
        <t-loading text="登录成功，正在进入后台…" size="small" />
      </div>
    </t-card>

    <NuxtLink to="/" class="login-home-link">← 返回 PanHub 首页</NuxtLink>
  </div>
</template>

<script setup lang="ts">
/**
 * 管理后台登录拦截页（2026-09-02 定稿，流程极简）
 *
 * 本页只做两件事：
 *   1. 直达本页时检查一次：已是管理员（cookie 有效 + isAdmin）→ 直接进后台；
 *      未登录/凭证失效 → 显示「微信登录」按钮；已登录非管理员 → 提示。
 *   2. 点「微信登录」→ 弹出 wx-auth 认证窗（关注公众号 + 验证码）→
 *      成功后跳回 redirect 目标——后续校验交给 /admin 的鉴权门（单一出口，
 *      本页不做二次探测，避免任何状态分叉）。
 *
 * 注意：SDK 延迟到点击登录时才 init——init 内部会做 silentCheck，
 * 拿 localStorage 残留的 mp: token 校验失败时会把整个 wxauth-token
 * cookie 删掉（连有效的新 token 一起），绝不能让它自动跑。
 */
import type { WxAuthSDK } from "~/composables/useWxAuth";
import { resolveWxAuth } from "~/composables/useWxAuth";
import { useAdminApi } from "~/composables/useAdminApi";

definePageMeta({
  title: "登录 · PanHub 管理",
  layout: "admin-auth",
});
useSeoMeta({
  title: "登录 · PanHub 管理",
  robots: "noindex,nofollow",
});

const { hasTokenCookie, checkAdminAuth } = useAdminApi();
const route = useRoute();

type LoginState = "checking" | "need-login" | "logging-in" | "no-admin" | "error" | "redirecting";
const state = ref<LoginState>("checking");
const errorMsg = ref("");

let wxAuth: WxAuthSDK | null = null;
let sdkInited = false;

/** 回跳地址：只允许站内路径，防开放重定向 */
function safeRedirect(): string {
  const r = route.query.redirect;
  const raw = Array.isArray(r) ? r[0] : r;
  return typeof raw === "string" && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/admin";
}

/** 进页/重试时的检查（不发 SDK、不碰 silentCheck） */
async function boot() {
  state.value = "checking";
  errorMsg.value = "";
  if (!hasTokenCookie()) {
    state.value = "need-login";
    return;
  }
  const status = await checkAdminAuth();
  if (status === "ok") {
    state.value = "redirecting";
    await navigateTo(safeRedirect());
  } else if (status === "no-admin") {
    state.value = "no-admin";
  } else if (status === "no-login") {
    // cookie 存在但已失效 → 当作未登录，展示登录按钮
    state.value = "need-login";
  } else {
    state.value = "error";
  }
}

/** 点登录：懒初始化 SDK → 弹认证窗 → 成功后跳回后台（校验交给 /admin） */
async function startLogin() {
  if (state.value === "logging-in") return;
  state.value = "logging-in";
  try {
    if (!sdkInited) {
      wxAuth = await resolveWxAuth();
      wxAuth.init({
        apiBase: "https://wx-auth.shenzjd.com",
        // required: 弹窗无关闭按钮、遮罩不可点穿，必须完成关注 + 验证码。
        // 不传 silent（避免 init 内部 silentCheck 用残留 token 删 cookie）
        required: true,
        onVerified: () => {
          // 认证成功 → 回后台；是否管理员由 /admin 的鉴权门判定
          state.value = "redirecting";
          void navigateTo(safeRedirect());
        },
        onError: (error: any) => {
          console.error("[admin-login] 认证失败", error);
          state.value = "need-login";
        },
      });
      sdkInited = true;
    }
    await wxAuth!.showAuthModal();
    // 弹窗 Promise 可能随关闭先 resolve；成功信号走 onVerified 回调
    if (state.value === "logging-in") state.value = "need-login";
  } catch (e) {
    console.error("[admin-login] 登录弹窗失败", e);
    state.value = "need-login";
  }
}

onMounted(boot);
</script>

<style scoped>
.login-page {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}
.login-card {
  width: 100%;
  border-radius: 14px;
}
.login-brand {
  display: flex;
  align-items: center;
  gap: 14px;
}
.login-brand-badge {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  background: #fff;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  overflow: hidden;
  box-shadow: 0 2px 8px rgba(37, 99, 235, 0.2);
}
.login-brand-logo {
  width: 44px;
  height: 44px;
  display: block;
  object-fit: cover;
}
.login-brand-text { min-width: 0; }
.login-title {
  margin: 0 0 4px;
  font-size: 18px;
  font-weight: 700;
  color: var(--td-text-color-primary, #1f2937);
  line-height: 1.3;
}
.login-subtitle {
  margin: 0;
  font-size: 13px;
  color: var(--td-text-color-secondary, #6b7280);
  line-height: 1.5;
}
.login-alert { border-radius: 8px; }
.login-btn { margin-top: 4px; }
.login-state {
  display: flex;
  justify-content: center;
  padding: 18px 0;
}
.login-home-link {
  font-size: 13px;
  color: var(--td-text-color-secondary, #6b7280);
  text-decoration: none;
}
.login-home-link:hover { color: var(--td-brand-color, #2563eb); }
</style>
