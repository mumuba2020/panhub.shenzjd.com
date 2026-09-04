<template>
  <div class="home">
    <!-- 英雄区域 + 热门搜索 -->
    <div class="hero-row">
      <div class="hero-noise" aria-hidden="true" />
      <header class="hero">
        <div class="hero-accent" aria-hidden="true" />
        <div class="hero-content">
          <div class="hero-badge">PanHub 搜索聚合引擎</div>
          <h1 class="hero-title">
            <span class="hero-title-line">一键检索</span>
            <span class="hero-title-line hero-title-line--accent">全网网盘资源</span>
          </h1>
          <p class="hero-description">
            聚合阿里云盘、夸克、百度网盘、115、迅雷等平台 · 快速、直达、少打扰
          </p>
          <ul class="hero-features" role="list">
            <li class="hero-feature">实时聚合</li>
            <li class="hero-feature">多平台覆盖</li>
            <li class="hero-feature">结果去重</li>
          </ul>
        </div>
        <div class="hero-shape" aria-hidden="true" />
      </header>
      <aside class="hero-aside">
        <ErrorBoundary message="热搜加载失败">
          <HotSearchSection ref="hotSearchRef" :on-search="quickSearch" />
        </ErrorBoundary>
      </aside>
    </div>

    <!-- 站点搜索统计（2026-09-01 替代"热搜趋势"入口：公开页不再展示搜索词与逐日榜单） -->
    <!-- 2026-09-03 口径改为"昨日"：昨日已结算，值恒定，配合服务端日缓存每天只读一次库 -->
    <div v-if="siteStats" class="stats-strip">
      <div class="stats-strip__item">
        <span class="stats-strip__value">{{ siteStats.yesterdaySearches.toLocaleString() }}</span>
        <span class="stats-strip__label">昨日搜索次数</span>
      </div>
      <div class="stats-strip__item">
        <span class="stats-strip__value">{{ siteStats.yesterdayTerms.toLocaleString() }}</span>
        <span class="stats-strip__label">昨日搜索词数</span>
      </div>
      <div class="stats-strip__item">
        <span class="stats-strip__value">{{ siteStats.totalSearches.toLocaleString() }}</span>
        <span class="stats-strip__label">累计搜索次数</span>
      </div>
      <div class="stats-strip__item">
        <span class="stats-strip__value">{{ siteStats.totalTerms.toLocaleString() }}</span>
        <span class="stats-strip__label">累计搜索词数</span>
      </div>
    </div>

    <!-- 搜索框 -->
    <SearchBox
      v-model="kw"
      :loading="searchState.loading"
      :paused="searchState.paused"
      :searched="searched"
      :placeholder="placeholder"
      @search="onSearch"
      @reset="fullReset"
      @pause="pauseSearch"
      @continue="handleContinueSearch" />

    <!-- 统计和过滤器 -->
    <div v-if="searched" class="stats-bar">
      <div class="stats-content">
        <div class="stats-main">
          <span class="stat-item">
            <span class="stat-label">结果</span>
            <span class="stat-value">{{ searchState.total }}</span>
          </span>
          <span class="stat-item">
            <span class="stat-label">用时</span>
            <span class="stat-value">{{ searchState.elapsedMs }}ms</span>
          </span>
          <span v-if="searchState.deepLoading && !searchState.paused" class="loading-indicator">
            <span class="pulse-dot"></span>
            <span class="loading-text">持续搜索中…</span>
          </span>
          <span v-if="searchState.paused" class="paused-indicator-bar">
            <span class="pause-icon">⏸</span>
            <span v-if="autoPausedAtLimit" class="paused-text">
              已找到 {{ searchState.total }} 条结果，可继续搜索更多
            </span>
            <span v-else class="paused-text">搜索已暂停</span>
          </span>
        </div>

        <!-- 平台过滤器 -->
        <div class="platform-filters" v-if="hasResults">
          <button
            :class="['filter-pill', { active: filterPlatform === 'all' }]"
            @click="filterPlatform = 'all'">
            全部 ({{ searchState.total }})
          </button>
          <button
            v-for="p in platforms"
            :key="p"
            :class="['filter-pill', { active: filterPlatform === p }]"
            @click="filterPlatform = p">
            {{ platformName(p) }} ({{ searchState.merged[p]?.length || 0 }})
          </button>
        </div>

      </div>
    </div>

    <!-- 搜索结果 -->
    <section v-if="hasResults" class="results-section">
      <div class="results-grid">
        <ResultGroup
          v-for="group in groupedResults"
          :key="group.type"
          :title="platformName(group.type)"
          :color="platformColor(group.type)"
          :icon="platformIcon(group.type)"
          :items="visibleSorted(group.items)"
          :expanded="filterPlatform !== 'all' || isExpanded(group.type)"
          :initial-visible="initialVisible"
          :can-toggle-collapse="false"
          @toggle="handleToggle(group.type)"
          @copy="copyLink" />
      </div>
    </section>

    <!-- 空状态：仅当搜索完全结束且无结果时显示，搜索进行中不显示 -->
    <section v-else-if="searched && !searchState.loading && !searchState.deepLoading && !searchState.paused" class="empty-state">
      <div class="empty-card">
        <div class="empty-card__main">
          <div class="empty-icon" aria-hidden="true">
            <svg
              width="44"
              height="44"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
              <path d="m8.5 8.5 5 5" />
              <path d="m13.5 8.5-5 5" />
            </svg>
          </div>
          <div class="empty-card__text">
            <h3>未找到相关资源</h3>
            <p>试试其他关键词，或稍后再试</p>
          </div>
        </div>
        <div v-if="hotTerms.length > 0" class="empty-suggestions">
          <span class="empty-suggestions__label">大家都在搜：</span>
          <div class="empty-suggestions__tags">
            <button
              v-for="term in hotTerms.slice(0, 5)"
              :key="term"
              class="empty-suggestions__tag"
              @click="quickSearch(term)">
              {{ term }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- 错误提示 -->
    <section v-if="searchState.error" class="error-alert">
      <span class="error-icon">⚠️</span>
      <span>{{ searchState.error }}</span>
    </section>

    <!-- 豆瓣电影新片榜 - 搜索时隐藏 -->
    <section v-if="!searched" class="douban-hot-section">
      <ErrorBoundary message="豆瓣热榜加载失败">
        <DoubanHotSection ref="doubanHotRef" :on-search="quickSearch" />
      </ErrorBoundary>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, nextTick } from "vue";
import { PLATFORM_INFO } from "~/config/plugins";
import { isBotUA } from "~/utils/botUA";

const config = useRuntimeConfig();
const apiBase = (config.public?.apiBase as string) || "/api";
const siteUrl = (config.public?.siteUrl as string) || "";
const route = useRoute();
const router = useRouter();

// 热搜组件引用
const hotSearchRef = ref<InstanceType<typeof HotSearchSection> | null>(null);
const doubanHotRef = ref<InstanceType<typeof DoubanHotSection> | null>(null);

// 页面加载时初始化热搜数据
onMounted(async () => {
  await nextTick();
  // 从 URL 读取搜索关键词
  const q = route.query.q;
  if (q && typeof q === "string") {
    // 爬虫抓取 /?q=xxx（来自 sitemap）时不自动搜索：否则每次抓取都触发一次
    // 完整搜索 + 记录热搜，形成自举循环。真人浏览器才自动搜索。
    if (isBotUA(typeof navigator !== "undefined" ? navigator.userAgent : undefined)) {
      kw.value = q; // 仍回填输入框，页面可读
    } else {
      kw.value = q;
      // 2026-08-28：必须走 onSearch（内部先 checkSearchAuth），不能直接
      // doSearch——否则 URL 带 ?q= 时绕过公众号认证，无凭证真人会拿到
      // 蜜罐数据而非弹出认证弹窗（与用户手动搜索行为一致）。
      await onSearch();
    }
  }
  if (doubanHotRef.value) await doubanHotRef.value.init();
  if (hotSearchRef.value) await hotSearchRef.value.init();
  fetchHotTerms();
  fetchSiteStats();
});

// SEO 元数据
useSeoMeta({
  title: "PanHub - 全网最全的网盘搜索",
  description:
    "聚合阿里云盘、夸克、百度网盘、115、迅雷等平台，实时检索各类分享链接与资源，快速、高效。",
  ogTitle: "PanHub - 全网最全的网盘搜索",
  ogDescription:
    "聚合阿里云盘、夸克、百度网盘、115、迅雷等平台，实时检索各类分享链接与资源，快速、高效。",
  ogType: "website",
  ogSiteName: "PanHub",
  ogImage:
    "https://cdn.jsdmirror.com/gh/wu529778790/img.shenzjd.com@master/blog/imgx-20260828-151509-5bk7.svg",
  twitterCard: "summary_large_image",
  twitterTitle: "PanHub - 全网最全的网盘搜索",
  twitterDescription:
    "聚合阿里云盘、夸克、百度网盘、115、迅雷等平台，实时检索各类分享链接与资源，快速、高效。",
  twitterImage:
    "https://cdn.jsdmirror.com/gh/wu529778790/img.shenzjd.com@master/blog/imgx-20260828-151509-5bk7.svg",
});

useHead({
  link: [{ rel: "canonical", href: siteUrl ? `${siteUrl}/` : "/" }],
  meta: [
    {
      name: "keywords",
      content:
        "网盘搜索, 阿里云盘搜索, 夸克网盘搜索, 百度网盘搜索, 115 网盘, 迅雷云盘, 资源搜索, 盘搜, PanHub",
    },
  ],
  script: [
    {
      type: "application/ld+json",
      innerHTML: JSON.stringify({
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: "PanHub",
        url: siteUrl || "",
        potentialAction: {
          "@type": "SearchAction",
          target: (siteUrl || "") + "/?q={search_term_string}",
          "query-input": "required name=search_term_string",
        },
      }),
    },
  ],
});

// 搜索相关状态
const kw = ref("");
const placeholder =
  "搜索网盘资源，支持百度云、阿里云盘、夸克网盘、115网盘、迅雷云盘、天翼云盘、123网盘、移动云盘、UC网盘等";

// 平台过滤（结果排序固定按时间最新在前，见 sortItems，不再提供其它排序选项）
const filterPlatform = ref<string>("all");
const initialVisible = 3;
const expandedSet = ref<Set<string>>(new Set());

// 空状态热搜推荐
const hotTerms = ref<string[]>([]);

async function fetchHotTerms() {
  try {
    const res = await fetch("/api/hot-searches?limit=5");
    const data = await res.json();
    if (data.code === 0) {
      hotTerms.value = data.data.hotSearches.map((s: any) => s.term);
    }
  } catch {}
}

// hero 下方统计带（2026-09-01 替代 /hot 页：公开侧只展示统计数，不展示搜索词）
// 接口侧全走 service TTL 读缓存，高频请求也不增加查库
const siteStats = ref<{
  yesterdayTerms: number;
  yesterdaySearches: number;
  totalSearches: number;
  totalTerms: number;
} | null>(null);

async function fetchSiteStats() {
  try {
    const res = await fetch("/api/hot-stats");
    const data = await res.json();
    if (data.code === 0 && data.data?.configured) {
      siteStats.value = {
        yesterdayTerms: data.data.yesterdayTerms,
        yesterdaySearches: data.data.yesterdaySearches,
        totalSearches: data.data.totalSearches,
        totalTerms: data.data.totalTerms,
      };
    }
  } catch {}
}

// 使用搜索 composable
const {
  state: searchState,
  searched,
  performSearch,
  resetSearch,
  copyLink,
  pauseSearch,
  continueSearch,
  hasResults,
  autoPausedAtLimit,
} = useSearch();
const { settings, loadSettings } = useSettings();
const { checkSearchAuth, forceVerify } = useWxAuth();

// 获取搜索选项（使用最新的用户设置）
function getSearchOptions() {
  return {
    apiBase,
    keyword: kw.value,
    settings: {
      // 2026-08-25：插件/频道知识全在后端，前端设置只保留并发与超时
      concurrency: settings.value.concurrency,
      pluginTimeoutMs: settings.value.pluginTimeoutMs,
    },
  };
}

// 执行实际搜索逻辑
async function doSearch() {
  if (!kw.value || searchState.value.loading) return;
  loadSettings();
  const keyword = kw.value.trim();
  // 搜索词由后端 search 接口自动记录（见 server/utils/recordSearchTerm.ts），前端不再上报
  // 同步搜索词到 URL
  if (router) {
    router.replace({ query: { q: keyword } });
  }
  await performSearch({
    ...getSearchOptions(),
    onAuthRequired: handleAuthRequired,
    onQuotaExceeded: handleQuotaExceeded,
  });
}

// 搜索接口返回 401 时回调（2026-08-22）：
// 服务端 requireWxAuth 实时校验 token 失效/取消关注 → 强制重新吊起
// 微信认证弹窗，认证成功后再重试搜索。
let wxAuthRetrying = false;
async function handleAuthRequired() {
  // 防止一次搜索并发多个子请求同时触发多次弹窗
  if (wxAuthRetrying) return;
  wxAuthRetrying = true;
  try {
    // 强制重新认证（重置 isVerified，重新弹关注公众号弹窗）
    const ok = await forceVerify();
    if (ok) {
      resetSearch();
      await doSearch();
    }
  } finally {
    wxAuthRetrying = false;
  }
}

// 搜索执行
async function onSearch() {
  if (!kw.value) return;
  // 暂停状态下发起新搜索：放弃旧任务重新开始（想继续旧搜索请点"继续"按钮）
  if (searchState.value.paused) {
    resetSearch();
  }
  if (searchState.value.loading) return;
  // 微信公众号认证（强制：未认证先完成关注+验证码验证，成功后自动继续搜索）
  const authed = await checkSearchAuth();
  if (!authed) return;
  await doSearch();
}

// 搜索接口返回 402 时回调（2026-09-04）：
// 页面端免费搜索次数用完（服务端 search.stream 按 openid 内存计数）→
// 弹 floating-unlock 广告弹窗，用户扫码看完激励视频广告后返回一次性票据，
// useSearch 自动带票据（X-Unlock-Ticket/Grant 头）重试本次搜索，
// 服务端调 wx-auth mp-reward/verify 验票核销后清零配额放行。
// 返回 null = 用户取消/失败 → useSearch 终止搜索并提示。
let unlockAdResolving = false;
async function handleQuotaExceeded() {
  if (unlockAdResolving) return null;
  unlockAdResolving = true;
  try {
    return await requireUnlockAd();
  } finally {
    unlockAdResolving = false;
  }
}

// 快速搜索
async function quickSearch(keyword: string) {
  kw.value = keyword;
  await onSearch();
}

// 继续搜索（从暂停处继续）
async function handleContinueSearch() {
  if (!searchState.value.paused) return;
  loadSettings();
  await continueSearch({
    ...getSearchOptions(),
    onAuthRequired: handleAuthRequired,
    onQuotaExceeded: handleQuotaExceeded,
  });
}

// 完全重置 - 清空输入框、结果、状态，并刷新页面
async function fullReset() {
  // 清空输入框和重置状态
  kw.value = "";
  filterPlatform.value = "all";
  expandedSet.value = new Set();
  resetSearch();
  // 清除 URL 参数
  if (router) {
    router.replace({ query: {} });
  }
  // 刷新页面以恢复初始状态（包括豆瓣电影）
  await nextTick();
  if (doubanHotRef.value) await doubanHotRef.value.init();
}

// 平台信息
const platformIcon = (t: string): string => PLATFORM_INFO[t]?.icon || "📦";
const platformName = (t: string): string => PLATFORM_INFO[t]?.name || t;
const platformColor = (t: string): string => PLATFORM_INFO[t]?.color || "#9ca3af";

// 获取所有有结果的平台类型。
// 2026-09-04：SSE 流推送时 merged 的 key 按首个结果到达顺序插入，次序随机，
// 这里按结果数量降序 → tab（pill）从左到右为数量多的平台。
const platforms = computed(() => {
  const m = searchState.value?.merged ?? {};
  return Object.keys(m)
    .filter((type) => (m[type]?.length ?? 0) > 0)
    .sort((a, b) => (m[b]?.length ?? 0) - (m[a]?.length ?? 0));
});

const groupedResults = computed(() => {
  const list: Array<{ type: string; items: any[] }> = [];
  const source =
    filterPlatform.value === "all"
      ? searchState.value.merged
      : { [filterPlatform.value]: searchState.value.merged[filterPlatform.value] || [] };
  for (const type of Object.keys(source)) {
    if (!source[type]?.length) continue;
    list.push({ type, items: source[type] || [] });
  }
  // 数量多的平台排前面（与上方 platforms tab 顺序一致）：
  // 流推送各组到达顺序不定，不能依赖 merged 的 key 顺序
  list.sort((a, b) => (b.items?.length ?? 0) - (a.items?.length ?? 0));
  return list;
});

// 展开/收起
function isExpanded(type: string) {
  return expandedSet.value.has(type);
}

function handleToggle(type: string) {
  filterPlatform.value = type;
}

function visibleItems(type: string, items: any[]) {
  return isExpanded(type) ? items : items.slice(0, initialVisible);
}

// 排序（2026-09-04：SSE 流推送时 merge 数组按到达批次 push，组内顺序乱序，
// 固定按发布时间降序在展示层实时重排——最新到达的结果永远在最前。
// 产品决定移除其它排序选项，故不再有 sortType 状态）
function sortItems(items: any[]) {
  return [...items].sort(
    (a, b) =>
      new Date(b?.datetime || "1970-01-01").getTime() -
      new Date(a?.datetime || "1970-01-01").getTime()
  );
}

function visibleSorted(items: any[]) {
  return sortItems(items);
}
</script>

<style scoped>
.home {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

/* 英雄区域 + 热门搜索（frontend-design: editorial + industrial） */
.hero-row {
  display: flex;
  align-items: stretch;
  gap: 0;
  position: relative;
  background: linear-gradient(145deg, rgba(15, 118, 110, 0.12) 0%, rgba(15, 118, 110, 0.04) 35%, rgba(245, 158, 11, 0.06) 70%, rgba(15, 118, 110, 0.08) 100%);
  border-radius: 20px;
  box-shadow: 0 4px 20px -4px rgba(15, 118, 110, 0.15);
  overflow: hidden;
}

.hero-noise {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0.04;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  mix-blend-mode: overlay;
  z-index: 0;
}

.hero {
  flex: 1;
  min-width: 0;
  padding: 24px 28px;
  text-align: left;
  position: relative;
  z-index: 1;
}

.hero-accent {
  position: absolute;
  top: 0;
  left: 0;
  width: 6px;
  height: 100%;
  background: linear-gradient(180deg, var(--primary) 0%, var(--secondary) 50%, var(--primary) 100%);
  opacity: 1;
}

.hero-content {
  position: relative;
  z-index: 2;
  padding-left: 12px;
}

.hero-badge {
  display: inline-block;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--primary);
  margin-bottom: 10px;
  padding: 6px 12px;
  background: rgba(15, 118, 110, 0.12);
  border: 1px solid rgba(15, 118, 110, 0.25);
  border-radius: 8px;
  font-family: "Manrope", sans-serif;
  animation: heroReveal 0.6s ease-out both;
  animation-delay: 0.05s;
}

.hero-title {
  font-family: "Syne", "Manrope", sans-serif;
  font-size: 36px;
  font-weight: 800;
  margin: 0 0 10px;
  color: var(--text-primary);
  letter-spacing: -0.04em;
  line-height: 1.1;
  max-width: 560px;
  animation: heroReveal 0.6s ease-out both;
  animation-delay: 0.12s;
}

.hero-title-line {
  display: block;
}

.hero-title-line--accent {
  background: linear-gradient(120deg, var(--primary) 0%, #0d9488 40%, var(--secondary) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.hero-description {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0 0 16px;
  line-height: 1.65;
  max-width: 520px;
  animation: heroReveal 0.6s ease-out both;
  animation-delay: 0.2s;
}

.hero-features {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 12px 20px;
}

.hero-feature {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--primary-dark);
  padding: 6px 12px;
  background: var(--bg-input);
  border: 1px solid rgba(15, 118, 110, 0.2);
  border-radius: 10px;
  transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;
  animation: heroReveal 0.6s ease-out both;
}

.hero-feature:nth-child(1) { animation-delay: 0.28s; }
.hero-feature:nth-child(2) { animation-delay: 0.34s; }
.hero-feature:nth-child(3) { animation-delay: 0.4s; }

.hero-feature:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(15, 118, 110, 0.15);
  border-color: rgba(15, 118, 110, 0.35);
}

.hero-shape {
  position: absolute;
  right: 8%;
  bottom: 10%;
  width: 120px;
  height: 120px;
  background: linear-gradient(135deg, rgba(15, 118, 110, 0.15) 0%, rgba(245, 158, 11, 0.08) 100%);
  border-radius: 30% 70% 70% 30% / 30% 30% 70% 70%;
  filter: blur(24px);
  pointer-events: none;
  z-index: 0;
}

@keyframes heroReveal {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.hero-aside {
  flex-shrink: 0;
  width: 340px;
}

/* 嵌入时去除热门搜索的独立卡片感 */
.hero-aside :deep(.tag-cloud-wrap),
.hero-aside :deep(.loading-state),
.hero-aside :deep(.tag-cloud-placeholder) {
  background: transparent;
  border: none;
  border-radius: 0;
  box-shadow: none;
}

.hero-aside :deep(.tag-cloud-wrap) {
  padding: 12px 16px;
  min-height: 260px;
}

.hero-aside :deep(.hot-tagcloud) {
  height: 240px !important;
}

/* 站点搜索统计带（hero 下方）：4 等分居中，数字为主视觉，列间细分隔线 */
.stats-strip {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  padding: 18px 16px;
  background: var(--bg-primary);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-md);
}

.stats-strip__item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  position: relative;
}

/* 列间分隔线（首列除外） */
.stats-strip__item + .stats-strip__item::before {
  content: "";
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  height: 70%;
  width: 1px;
  background: var(--border-light);
}

.stats-strip__value {
  font-size: 24px;
  font-weight: 800;
  line-height: 1.2;
  color: var(--primary);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em;
}

.stats-strip__label {
  font-size: 12px;
  color: var(--text-tertiary);
  letter-spacing: 0.05em;
}

@media (max-width: 640px) {
  /* 窄屏 2×2：隐藏竖分隔线，用行距分组 */
  .stats-strip {
    grid-template-columns: repeat(2, 1fr);
    gap: 16px 0;
    padding: 16px 8px;
  }

  .stats-strip__item + .stats-strip__item::before {
    display: none;
  }

  .stats-strip__value {
    font-size: 20px;
  }
}

/* 统计和过滤器栏 */
.stats-bar {
  background: var(--bg-primary);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
  padding: 16px;
  box-shadow: var(--shadow-md);
  animation: fadeIn 0.4s ease;
}

.stats-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.stats-main {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}

.stat-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-light);
}

.stat-label {
  font-size: 13px;
  color: var(--text-tertiary);
  font-weight: 500;
}

.stat-value {
  font-size: 18px;
  font-weight: 700;
  color: var(--primary);
}

/* 加载指示器 */
.loading-indicator {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(15, 118, 110, 0.1);
  border-radius: var(--radius-md);
  border: 1px solid rgba(15, 118, 110, 0.2);
}

.pulse-dot {
  width: 8px;
  height: 8px;
  background: var(--primary);
  border-radius: 50%;
  animation: pulse 1.5s ease-in-out infinite;
}

.loading-text {
  font-size: 13px;
  color: var(--primary);
  font-weight: 500;
}

/* 暂停状态指示器（统计栏） */
.paused-indicator-bar {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(245, 158, 11, 0.1);
  border-radius: var(--radius-md);
  border: 1px solid rgba(245, 158, 11, 0.3);
  color: #f59e0b;
  font-weight: 500;
}

.pause-icon {
  font-size: 14px;
}

.paused-text {
  font-size: 13px;
}

/* 平台过滤器 */
.platform-filters {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}

.filter-pill {
  padding: 6px 12px;
  border: 1px solid var(--border-light);
  background: var(--bg-secondary);
  border-radius: 999px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background-color var(--transition-fast), border-color var(--transition-fast),
    color var(--transition-fast), transform var(--transition-fast),
    box-shadow var(--transition-fast);
  white-space: nowrap;
}

.filter-pill:hover {
  background: var(--bg-primary);
  border-color: var(--border-medium);
  transform: translateY(-1px);
}

.filter-pill.active {
  background: linear-gradient(135deg, var(--primary), var(--secondary));
  color: white;
  border-color: transparent;
  box-shadow: 0 4px 12px rgba(15, 118, 110, 0.28);
}

/* 搜索结果区域 */
.results-section {
  animation: fadeIn 0.5s ease;
}

.results-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
}

/* 空状态 */
.empty-state {
  display: flex;
  justify-content: center;
  align-items: stretch;
  padding: 32px 0;
  animation: fadeIn 0.4s ease;
}

.empty-card {
  width: 100%;
  background: var(--bg-primary);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-xl);
  padding: 40px 44px;
  box-shadow: var(--shadow-xl);
  display: flex;
  align-items: center;
  gap: 40px;
  flex-wrap: wrap;
}

.empty-card__main {
  display: flex;
  align-items: center;
  gap: 24px;
  min-width: 280px;
  flex: 1 1 320px;
}

.empty-icon {
  flex-shrink: 0;
  width: 88px;
  height: 88px;
  border-radius: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(
    135deg,
    rgba(255, 255, 255, 0.6) 0%,
    rgba(255, 255, 255, 0.2) 100%
  );
  border: 1px solid rgba(255, 255, 255, 0.5);
  color: var(--primary);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
}

.empty-card__text h3 {
  margin: 0 0 8px 0;
  font-size: 22px;
  font-weight: 600;
  color: var(--text-primary);
}

.empty-card__text p {
  margin: 0;
  font-size: 14px;
  color: var(--text-secondary);
  line-height: 1.6;
}

.empty-suggestions {
  flex: 1 1 320px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  border-left: 1px solid var(--border-light);
  padding-left: 40px;
}
.empty-suggestions__label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-tertiary);
}
.empty-suggestions__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.empty-suggestions__tag {
  font-size: 14px;
  padding: 6px 16px;
  border-radius: 999px;
  border: 1px solid var(--border-light);
  background: var(--bg-secondary);
  color: var(--text-primary);
  cursor: pointer;
  transition: all var(--transition-fast);
}
.empty-suggestions__tag:hover {
  border-color: var(--primary);
  color: var(--primary);
  transform: translateY(-1px);
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.06);
}

/* 错误提示 */
.error-alert {
  display: flex;
  align-items: center;
  gap: 12px;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: var(--radius-md);
  padding: 12px 16px;
  color: var(--error);
  font-weight: 500;
  animation: fadeIn 0.3s ease;
}

.error-icon {
  font-size: 18px;
}

/* 热搜推荐 */
.hot-search-section {
  animation: fadeIn 0.6s ease;
}

/* 移动端优化 */
@media (max-width: 900px) {
  .hero-row {
    flex-direction: column;
  }

  .hero-aside {
    width: 100%;
  }
}

@media (max-width: 640px) {
  .hero-aside {
    display: none;
  }

  .hero {
    padding: 24px 18px;
  }

  .hero-content {
    padding-left: 4px;
  }

  .hero-badge {
    font-size: 10px;
    letter-spacing: 0.1em;
    margin-bottom: 10px;
  }

  .hero-title {
    font-size: 26px;
  }

  .hero-description {
    font-size: 14px;
    margin-bottom: 16px;
  }

  .hero-feature {
    font-size: 12px;
    padding: 6px 12px;
  }

  .hero-shape {
    width: 80px;
    height: 80px;
    right: 5%;
    bottom: 5%;
  }

  .stats-bar {
    padding: 12px;
  }

  .stats-main {
    gap: 8px;
  }

  .stat-item {
    padding: 6px 10px;
  }

  .stat-value {
    font-size: 16px;
  }

  .platform-filters {
    gap: 6px;
  }

  .filter-pill {
    padding: 5px 10px;
    font-size: 12px;
  }

  .empty-card {
    padding: 24px 20px;
    flex-direction: column;
    align-items: flex-start;
    gap: 20px;
  }

  .empty-card__main {
    min-width: 0;
    width: 100%;
    gap: 16px;
  }

  .empty-icon {
    width: 64px;
    height: 64px;
    border-radius: 18px;
  }

  .empty-icon svg {
    width: 36px;
    height: 36px;
  }

  .empty-card h3 {
    font-size: 18px;
  }

  .empty-suggestions {
    width: 100%;
    border-left: none;
    padding-left: 0;
    padding-top: 16px;
    border-top: 1px solid var(--border-light);
  }

  .suggestions-card {
    padding: 16px;
  }

  .tag {
    padding: 6px 12px;
    font-size: 12px;
  }
}

/* 高对比度模式支持 */
@media (prefers-contrast: high) {
  .hero-title-line--accent {
    -webkit-text-fill-color: var(--primary);
    background: none;
  }

  .hero-badge,
  .hero-feature {
    border-width: 2px;
  }

  .filter-pill.active {
    border-width: 2px;
  }

  .tag {
    border-width: 2px;
  }
}

/* 减少动画模式支持 */
@media (prefers-reduced-motion: reduce) {
  .hero-badge,
  .hero-title,
  .hero-description,
  .hero-feature {
    animation: none;
  }

  .hero-feature:hover {
    transform: none;
  }

  .hero,
  .stats-bar,
  .results-section,
  .empty-state,
  .error-alert,
  .hot-search-section {
    animation: none;
  }

  .filter-pill:hover {
    transform: none;
  }

  .pulse-dot {
    animation: none;
    opacity: 0.7;
  }
}

</style>
