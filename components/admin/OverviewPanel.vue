<template>
  <section class="ov-section">
    <!-- 页头：标题 + 副标题 + 右侧操作 -->
    <div class="ov-page-head">
      <div class="ov-page-title-group">
        <h1 class="ov-page-title">数据概览</h1>
        <p class="ov-page-subtitle">实时监控网盘搜索服务的运行状况</p>
      </div>
      <div class="ov-page-actions">
        <t-select v-model="range" class="ov-range-select" aria-label="时间范围" @change="load">
          <t-option value="7" label="近 7 天" />
          <t-option value="30" label="近 30 天" />
          <t-option value="90" label="近 90 天" />
        </t-select>
        <t-button :loading="loading" @click="load">刷新</t-button>
      </div>
    </div>

    <t-alert v-if="error" theme="error" :message="error" class="ov-alert" />

    <t-loading :loading="loading && !data" text="加载中…" show-overlay class="ov-body">
      <template v-if="data">
        <!-- KPI 卡片行：全部来自 /api/admin/stats 真实聚合 -->
        <div class="ov-kpis">
          <t-card size="small" class="ov-kpi">
            <t-statistic title="今日搜索次数" :value="data.search.todayCount" />
          </t-card>
          <t-card size="small" class="ov-kpi">
            <t-statistic title="今日搜索词数" :value="data.search.todayTerms" />
          </t-card>
          <t-card size="small" class="ov-kpi">
            <t-statistic title="数据源 / 频道" :value="channelCount ?? 0" />
          </t-card>
          <t-card size="small" class="ov-kpi">
            <t-statistic title="封禁中 IP" :value="data.defense.blocked" />
          </t-card>
          <t-card size="small" class="ov-kpi">
            <t-statistic title="黑名单累计" :value="data.defense.total" />
          </t-card>
        </div>

        <!-- 双栏：搜索趋势 + 热门搜索词 -->
        <div class="ov-row">
          <!-- 近 {days} 天搜索量（柱状图） -->
          <t-card class="ov-block">
            <template #header>
              <div class="ov-block-head">
                <div class="ov-block-title">搜索趋势</div>
                <div class="ov-block-sub">近 {{ daysLabel }} 搜索次数</div>
              </div>
            </template>
            <div class="ov-chart">
              <div v-for="d in data.search.trend" :key="d.date" class="ov-bar-col" :title="`${d.date}：${d.count} 次`">
                <span class="ov-bar-val" v-if="d.count > 0">{{ d.count }}</span>
                <div class="ov-bar" :style="{ height: barHeight(d.count) }"></div>
                <div class="ov-bar-label">{{ shortDate(d.date) }}</div>
              </div>
            </div>
          </t-card>

          <!-- 热门搜索词（TOP 榜单） -->
          <t-card class="ov-block">
            <template #header>
              <div class="ov-block-head">
                <div class="ov-block-title">热门搜索词</div>
                <div class="ov-block-sub">近 {{ daysLabel }}</div>
              </div>
            </template>
            <ol v-if="data.search.topTerms.length" class="ov-hot-list">
              <li v-for="(t, i) in data.search.topTerms" :key="t.term" class="ov-hot-item">
                <span :class="['ov-hot-rank', { 'ov-hot-rank-top': i < 3 }]">{{ i + 1 }}</span>
                <span class="ov-hot-term">{{ t.term }}</span>
                <span class="ov-hot-count">{{ t.count }}</span>
              </li>
            </ol>
            <p v-else class="admin-hint" style="text-align:center; padding:24px 0">近 {{ daysLabel }} 暂无数据</p>
          </t-card>
        </div>

        <!-- 惯犯 IP TOP 榜（stats 接口 defense 数据，2026-09-01 起启用） -->
        <t-card class="ov-block">
          <template #header>
            <div class="ov-block-head">
              <div class="ov-block-title">高频拦截 IP</div>
              <div class="ov-block-sub">按累计拒绝次数排序</div>
            </div>
          </template>
          <t-table
            v-if="data.defense.topIps.length"
            row-key="ip"
            :data="data.defense.topIps"
            :columns="defenseColumns"
            :max-height="280"
            size="small"
          />
          <p v-else class="admin-hint" style="text-align:center; padding:24px 0">暂无拦截记录</p>
        </t-card>
      </template>
    </t-loading>
  </section>
</template>

<script setup lang="ts">
/**
 * 数据概览面板（2026-09-01 TDesign 化重构 + 假数据清理）
 * 数据源 /api/admin/stats（管理员只读聚合）：
 * - search：今日搜索次数/词数 + 近 N 天趋势 + TOP 搜索词
 * - defense：黑名单累计/封禁中/今日活跃 + 高频拦截 IP
 *
 * 2026-09-01 清理（旧版问题）：
 * - 删除写死的 KPI 环比假数据（↑12.4% / ↑5.8%，接口根本没有环比）
 * - 删除「最近搜索记录」假表格（由 TOP 词拼行、openid/IP 全空、
 *   分页按钮 disabled 摆设）——真实明细请用「搜索记录」面板定向查
 * - 删除频道数失败兜底假值 61
 */
import { useAdminApi } from "~/composables/useAdminApi";

const { loadStats, loadChannels } = useAdminApi();

const loading = ref(false);
const error = ref("");
const data = ref<Awaited<ReturnType<typeof loadStats>> | null>(null);
const channelCount = ref<number | null>(null);
const range = ref("7");
const daysLabel = computed(() => (range.value === "7" ? "7 天" : range.value === "30" ? "30 天" : "90 天"));

/** 高频拦截 IP 表列（TDesign t-table） */
const defenseColumns = [
  { colKey: "ip", title: "IP", cell: (_h: any, { row }: any) => row.ip },
  {
    colKey: "reason",
    title: "原因",
    cell: (_h: any, { row }: any) => REASON_TEXT[row.reason as string] ?? row.reason ?? "-",
  },
  { colKey: "hitCount", title: "累计拒绝" },
  {
    colKey: "blockCount",
    title: "封禁档位",
    cell: (_h: any, { row }: any) => blockLevelText(row.blockCount),
  },
  {
    colKey: "expiresAt",
    title: "解封时间（北京）",
    cell: (_h: any, { row }: any) => formatTime(row.expiresAt),
  },
];

const REASON_TEXT: Record<string, string> = {
  bot_ua: "爬虫UA",
  rate_limit: "限流",
  bad_term: "非法词",
  wx_auth: "未关注公众号",
  manual: "手动拉黑",
};

function blockLevelText(blockCount?: number): string {
  if (!blockCount) return "未拉黑";
  if (blockCount === 1) return "24 小时";
  if (blockCount === 2) return "7 天";
  return "30 天";
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    data.value = await loadStats();
    // 频道数独立拉取，失败显示 "-"，不再兜底假值
    if (channelCount.value === null) {
      try {
        const c = await loadChannels();
        channelCount.value = c.priorityCount + c.defaultCount;
      } catch {
        channelCount.value = null;
      }
    }
  } catch (e: any) {
    error.value = e?.message || "加载失败";
  } finally {
    loading.value = false;
  }
}

/** 趋势柱高：按最大值归一化到 120px */
function barHeight(count: number): string {
  const max = Math.max(1, ...(data.value?.search.trend.map((d) => d.count) ?? [1]));
  const h = Math.max(4, Math.round((count / max) * 120));
  return `${h}px`;
}

function shortDate(date: string): string {
  return date.slice(5); // MM-DD
}

function formatTime(ms?: number): string {
  if (!ms) return "-";
  const d = new Date(ms + 8 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

onMounted(load);
</script>

<style scoped>
.ov-section { display: flex; flex-direction: column; gap: 20px; }
.ov-body { min-height: 120px; border-radius: 12px; }
.ov-alert { border-radius: 8px; }

/* ===== 页头 ===== */
.ov-page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
}
.ov-page-title-group { display: flex; flex-direction: column; gap: 4px; }
.ov-page-title {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  color: var(--text-primary, #1f2937);
  line-height: 1.3;
}
.ov-page-subtitle {
  margin: 0;
  font-size: 13px;
  color: var(--text-tertiary, #94a3b8);
}
.ov-page-actions { display: flex; align-items: center; gap: 12px; }
.ov-range-select { width: 120px; }

/* ===== KPI 卡行（t-card + t-statistic） ===== */
.ov-kpis {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 16px;
}

/* ===== 双栏（t-card 外壳，只管布局） ===== */
.ov-row {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  gap: 16px;
}
.ov-block-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.ov-block-title { font-size: 15px; font-weight: 600; color: var(--text-primary, #1f2937); }
.ov-block-sub { font-size: 12px; color: var(--text-tertiary, #94a3b8); }

/* 柱状图 */
.ov-chart {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  height: 150px;
  padding-top: 10px;
}
.ov-bar-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  height: 100%;
  position: relative;
}
.ov-bar-val {
  font-size: 11px;
  color: var(--text-tertiary, #94a3b8);
  font-variant-numeric: tabular-nums;
}
.ov-bar {
  width: 100%;
  max-width: 36px;
  min-height: 4px;
  background: linear-gradient(180deg, #3b82f6, #2563eb);
  border-radius: 6px 6px 0 0;
  opacity: 0.9;
  transition: height 0.2s ease;
}
.ov-bar-label {
  font-size: 11px;
  color: var(--text-tertiary, #94a3b8);
}

/* 热门搜索词 TOP 榜 */
.ov-hot-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ov-hot-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border-light, #f0f2f5);
  font-size: 13px;
}
.ov-hot-item:last-child { border-bottom: none; }
.ov-hot-rank {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary, #475569);
  background: var(--bg-secondary, #f4f6f9);
}
.ov-hot-rank-top { background: var(--primary, #2563eb); color: #fff; }
.ov-hot-term {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary, #1f2937);
}
.ov-hot-count {
  font-size: 12px;
  color: var(--text-tertiary, #94a3b8);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 900px) {
  .ov-kpis { grid-template-columns: repeat(2, 1fr); }
  .ov-row { grid-template-columns: 1fr; }
  .ov-page-head { flex-direction: column; align-items: flex-start; }
}
</style>
