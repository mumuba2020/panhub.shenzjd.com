<template>
  <t-card title="IP 黑名单" description="封禁中+惯犯档案+计数记录 · 顽固爬虫分级递增（24h → 7 天 → 30 天）">
    <template #actions>
      <t-button variant="outline" :disabled="loading" :loading="loading" @click="refresh()">
        刷新
      </t-button>
      <t-button theme="primary" variant="outline" @click="toggleLookup">
        {{ lookupOpen ? "收起蜜罐反馈" : "蜜罐反馈解封" }}
      </t-button>
    </template>

    <!-- 蜜罐反馈处理（2026-09-03）：用户拿 openid 反馈"看到蜜罐" → 反查受影响 IP → 一键解封 -->
    <div v-if="lookupOpen" class="hp-wrap">
      <div class="hp-head">
        <t-radio-group v-model="lookupMode" variant="default-filled" size="small">
          <t-radio-button value="openid">按 openid 查（用户反馈）</t-radio-button>
          <t-radio-button value="ip">按 IP 查（谁被影响）</t-radio-button>
        </t-radio-group>
        <div class="admin-form-row hp-form">
          <t-input
            v-model="lookupKeyword"
            class="admin-input-t"
            :placeholder="lookupMode === 'openid' ? '输入用户 openid，如 oXXXX…' : '输入被封 IP…'"
            clearable
            @enter="doLookup"
          />
          <t-button theme="primary" :disabled="!lookupKeyword.trim() || lookupLoading" :loading="lookupLoading" @click="doLookup">
            反查
          </t-button>
        </div>
      </div>
      <t-alert v-if="lookupError" theme="error" :message="lookupError" class="hp-alert" />

      <template v-if="lookupDone">
        <!-- openid 反查结果：受影响 IP + 封禁状态 + 一键解封 -->
        <div v-if="lookupResult?.mode === 'openid'">
          <div class="admin-list-head">
            <span>该 openid 关联的 IP：{{ lookupResult.items.length }} 条（来源：蜜罐命中 / 搜索历史兜底；仅封禁中的会影响其当前搜索）</span>
          </div>
          <div v-if="lookupResult.items[0]?.source === 'search_log'" class="admin-hint" style="margin: 4px 0 8px">
            未命中蜜罐记录，按搜索历史兜底定位（有成功搜索记录即能查到 IP）
          </div>
          <t-table
            v-if="lookupResult.items.length"
            row-key="ip"
            :data="lookupResult.items"
            :columns="hpOpenidColumns"
            size="small"
            :max-height="360"
          >
            <template #status-slot="{ row }">
              <t-tag v-if="row.blocked" theme="danger" variant="light">封禁中</t-tag>
              <t-tag v-else theme="default" variant="light">已解封</t-tag>
            </template>
            <template #last-slot="{ row }">
              <span class="mono">{{ formatTime(row.honeypotLastAt) }}</span>
            </template>
            <template #op-slot="{ row }">
              <t-button
                v-if="row.blocked"
                theme="danger"
                variant="outline"
                size="small"
                :loading="lookupBusy === `unblock-${row.ip}`"
                @click="askUnblock(row.ip)">
                解封
              </t-button>
              <span v-else class="admin-hint">-</span>
            </template>
          </t-table>
          <div v-else class="admin-state">该 openid 没有关联的封禁记录（蜜罐表与搜索历史都没有该 openid 的 IP 记录）</div>
        </div>

        <!-- IP 反查结果：该 IP 影响了哪些 openid -->
        <div v-else-if="lookupResult?.mode === 'ip'">
          <div class="admin-list-head">
            <span>IP {{ lookupResult.ip }} 最近影响了 {{ lookupResult.items.length }} 个 openid</span>
            <t-tag v-if="lookupResult.block?.blocked" theme="danger" variant="light" style="margin-left:8px">该 IP 当前封禁中</t-tag>
          </div>
          <t-table
            v-if="lookupResult.items.length"
            row-key="openid"
            :data="lookupResult.items"
            :columns="hpIpColumns"
            size="small"
            :max-height="360"
          >
            <template #last-slot="{ row }">
              <span class="mono">{{ formatTime(row.honeypotLastAt) }}</span>
            </template>
            <template #op-slot="{ row }">
              <t-button
                variant="outline"
                size="small"
                @click="copyOpenid(row.openid)">
                复制 openid
              </t-button>
            </template>
          </t-table>
          <div v-else class="admin-state">该 IP 没有影响过带凭证的真人（纯爬虫来源，无人被误伤）</div>
        </div>
      </template>
    </div>

    <!-- 筛选：IP 搜索 + 状态 -->
    <div class="admin-form-row" style="margin-bottom: 10px">
      <t-input
        v-model="ipFilter"
        class="admin-input-t"
        placeholder="按 IP 搜索（支持部分匹配）…"
        clearable
        @enter="doFilter"
      />
      <t-select v-model="status" class="bl-status" aria-label="状态筛选" @change="doFilter">
        <t-option value="" label="全部" />
        <t-option value="blocked" label="封禁中" />
        <t-option value="free" label="已解封" />
      </t-select>
      <t-button variant="outline" @click="doFilter">筛选</t-button>
    </div>

    <t-alert v-if="error" theme="error" :message="error" class="bl-alert" />

    <div class="admin-list-head">
      <span>共 {{ total }} 条（{{ statusLabel }}）</span>
    </div>

    <t-loading :loading="loading && items.length > 0" show-overlay>
      <t-table
        v-if="items.length > 0"
        row-key="ip"
        :data="items"
        :columns="columns"
        :max-height="520"
        size="small"
      >
        <template #reason-slot="{ row }">
          {{ reasonText[row.reason ?? ""] ?? row.reason ?? "-" }}
        </template>
        <template #status-slot="{ row }">
          <t-tag :theme="row.blocked ? 'danger' : 'default'" variant="light">
            {{ row.blocked ? "封禁中" : "已解封" }}
          </t-tag>
        </template>
        <template #level-slot="{ row }">{{ blockLevelText(row.blockCount) }}</template>
        <template #remaining-slot="{ row }">{{ row.blocked ? formatDuration(row.remainingMs) : "-" }}</template>
        <template #expires-slot="{ row }">
          <span class="mono">{{ formatTime(row.expiresAt) }}</span>
        </template>
        <template #last-slot="{ row }">
          <span class="mono">{{ formatTime(row.lastAt) }}</span>
        </template>
        <template #op-slot="{ row }">
          <t-button
            variant="outline"
            size="small"
            :loading="busyKey === `remove-${row.ip}`"
            @click="askRemove(row.ip)">
            移除
          </t-button>
        </template>
      </t-table>
      <div v-else-if="!error" class="admin-state">暂无符合条件的记录</div>

      <!-- 分页（change 回调参数是 PageInfo 对象，取 current） -->
      <t-pagination
        v-if="totalPages > 1"
        class="bl-pager"
        :current="page"
        :page-size="PAGE_SIZE"
        :total="total"
        :show-page-size="false"
        :show-jumper="false"
        :disabled="loading"
        @change="(info: any) => go(info.current)"
      />
    </t-loading>

    <!-- 确认弹窗：移除（黑名单页原操作） / 解封（蜜罐反馈反查） -->
    <AdminModal ref="modalRef" :title="'移除 IP'" tone="danger" confirm-text="确认移除" />
    <AdminModal ref="unblockModal" :title="'解封该 IP'" tone="danger" confirm-text="确认解封" />
  </t-card>
</template>

<script setup lang="ts">
/**
 * IP 黑名单面板（2026-09-01 TDesign 化：t-table + t-pagination + t-tag）
 * 展示 /api/blacklist 封禁中 + 惯犯档案；"移除"即解除封禁。
 * - IP 模糊搜索 + 状态筛选（封禁中/已解封/全部）
 * - limit=50 分页
 */
import { MessagePlugin } from "tdesign-vue-next";
import { useAdminApi, type BlacklistItem } from "~/composables/useAdminApi";
import AdminModal from "~/components/admin/AdminModal.vue";

const { loadBlacklist, removeIp, lookupHoneypot } = useAdminApi();
const modalRef = ref<InstanceType<typeof AdminModal>>();

const loading = ref(false);
const error = ref("");
const items = ref<BlacklistItem[]>([]);
const total = ref(0);
const busyKey = ref("");

// ===== 蜜罐反馈解封（2026-09-03 openid 反查闭环）=====
const lookupOpen = ref(false);
const lookupMode = ref<"openid" | "ip">("openid");
const lookupKeyword = ref("");
const lookupLoading = ref(false);
const lookupError = ref("");
const lookupDone = ref(false);
const lookupResult = ref<any>(null);
const lookupBusy = ref("");
const unblockModal = ref<InstanceType<typeof AdminModal>>();
let pendingUnblockIp = "";

const ipFilter = ref("");
const status = ref<"" | "blocked" | "free">("");
const page = ref(1);
const PAGE_SIZE = 50;

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));
const statusLabel = computed(() =>
  status.value === "blocked" ? "封禁中" : status.value === "free" ? "已解封" : "全部",
);

/** t-table 列定义（cell 指向上方具名插槽） */
const columns = [
  { colKey: "ip", title: "IP", cell: (_h: any, { row }: any) => row.ip },
  { colKey: "reason", title: "原因", cell: "reason-slot" },
  { colKey: "status", title: "状态", cell: "status-slot", width: 90 },
  { colKey: "level", title: "封禁档位", cell: "level-slot", width: 90 },
  { colKey: "remaining", title: "剩余", cell: "remaining-slot", width: 90 },
  { colKey: "expires", title: "解封时间（北京）", cell: "expires-slot", width: 150 },
  { colKey: "hitCount", title: "累计拒绝", width: 90, cell: (_h: any, { row }: any) => row.hitCount ?? 0 },
  { colKey: "last", title: "最近活动（北京）", cell: "last-slot", width: 150 },
  { colKey: "ops", title: "操作", cell: "op-slot", width: 90 },
];

const reasonText: Record<string, string> = {
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

/** 蜜罐反查列（openid 模式）：受影响 IP + 封禁状态 + 解封 */
const hpOpenidColumns = [
  { colKey: "ip", title: "IP", cell: (_h: any, { row }: any) => row.ip },
  { colKey: "last", title: "最近蜜罐命中（北京）", cell: "last-slot" },
  { colKey: "honeypotHits", title: "命中次数", width: 90, cell: (_h: any, { row }: any) => row.honeypotHits ?? 0 },
  { colKey: "status", title: "状态", cell: "status-slot", width: 90 },
  {
    colKey: "expires",
    title: "解封时间（北京）",
    cell: (_h: any, { row }: any) => (row.blocked ? formatTime(row.expiresAt) : "-"),
    width: 150,
  },
  { colKey: "ops", title: "操作", cell: "op-slot", width: 90 },
];

/** 蜜罐反查列（ip 模式）：被影响的 openid 列表 */
const hpIpColumns = [
  { colKey: "openid", title: "openid", cell: (_h: any, { row }: any) => row.openid, ellipsis: true },
  { colKey: "last", title: "最近命中（北京）", cell: "last-slot" },
  { colKey: "honeypotHits", title: "命中次数", width: 90, cell: (_h: any, { row }: any) => row.honeypotHits ?? 0 },
  { colKey: "ops", title: "操作", cell: "op-slot", width: 110 },
];

function formatDuration(ms?: number): string {
  if (!ms || ms <= 0) return "-";
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时`;
  return `${Math.floor(h / 24)} 天`;
}

function formatTime(ms?: number): string {
  if (!ms) return "-";
  const d = new Date(ms + 8 * 3600 * 1000); // 北京时间
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

async function load(opts?: { resetPage?: boolean }) {
  loading.value = true;
  error.value = "";
  if (opts?.resetPage) page.value = 1;
  try {
    const data = await loadBlacklist({
      limit: PAGE_SIZE,
      offset: (page.value - 1) * PAGE_SIZE,
      ip: ipFilter.value,
      status: status.value,
    });
    items.value = data.items ?? [];
    total.value = data.total ?? items.value.length;
  } catch (e: any) {
    error.value = e?.message || "请求异常";
  } finally {
    loading.value = false;
  }
}

/** 筛选变化 → 回到第 1 页重新拉 */
function doFilter() {
  load({ resetPage: true });
}

function go(p: number) {
  if (typeof p !== "number" || p < 1 || p > totalPages.value) return;
  page.value = p;
  load();
}

function askRemove(ip: string) {
  modalRef.value?.open({
    title: "移除 IP",
    message: `确定将 IP ${ip} 移出黑名单？\n将立即解除封禁（删除该 IP 的全部记录）。`,
    onConfirm: async () => {
      await doRemove(ip);
    },
  });
}

async function doRemove(ip: string) {
  if (busyKey.value) return;
  busyKey.value = `remove-${ip}`;
  try {
    await removeIp(ip);
    // 从当前结果剔除该 IP 的行；若本页删空且不是第一页则回退一页
    items.value = items.value.filter((it) => it.ip !== ip);
    total.value = Math.max(0, total.value - 1);
    if (items.value.length === 0 && page.value > 1) page.value -= 1;
    MessagePlugin.success(`已移除 ${ip}`);
    await load();
  } catch (e: any) {
    MessagePlugin.error(e?.message || "移除失败");
    throw e; // 让 modal 保持打开显示错误
  } finally {
    busyKey.value = "";
  }
}

// ===== 蜜罐反馈解封逻辑（2026-09-03）=====

function toggleLookup() {
  lookupOpen.value = !lookupOpen.value;
  if (lookupOpen.value) lookupDone.value = false;
}

/** 模式切换时清掉上次结果 */
function doLookup() {
  const kw = lookupKeyword.value.trim();
  if (!kw) return;
  lookupLoading.value = true;
  lookupError.value = "";
  lookupDone.value = false;
  const params = lookupMode.value === "openid" ? { openid: kw } : { ip: kw };
  lookupHoneypot({ ...params, limit: 50 })
    .then((res: any) => {
      lookupResult.value = res;
      lookupDone.value = true;
    })
    .catch((e: any) => {
      lookupError.value = e?.message || "反查失败";
    })
    .finally(() => {
      lookupLoading.value = false;
    });
}

/** 确认解封 openid 反查命中的 IP */
function askUnblock(ip: string) {
  pendingUnblockIp = ip;
  unblockModal.value?.open({
    title: "解封该 IP",
    message: `确定解封 IP ${ip}？\n该用户反馈"看到蜜罐数据"，此 IP 被拉黑疑似误伤真实用户。\n解封后将立即恢复搜索。`,
    tone: "danger",
    confirmText: "确认解封",
    onConfirm: async () => {
      await doUnblock(pendingUnblockIp);
    },
  });
}

async function doUnblock(ip: string) {
  if (lookupBusy.value) return;
  lookupBusy.value = `unblock-${ip}`;
  try {
    await removeIp(ip);
    MessagePlugin.success(`已解封 ${ip}`);
    // 反查结果里该 IP 置为已解封
    if (lookupResult.value?.mode === "openid") {
      const row = lookupResult.value.items.find((it: any) => it.ip === ip);
      if (row) {
        row.blocked = false;
        row.remainingMs = 0;
      }
    }
    // 同步刷新黑名单列表
    await load();
  } catch (e: any) {
    MessagePlugin.error(e?.message || "解封失败");
    throw e; // 让 modal 保持打开显示错误
  } finally {
    lookupBusy.value = "";
  }
}

function copyOpenid(openid: string) {
  try {
    if (navigator.clipboard) {
      void navigator.clipboard.writeText(openid);
    }
    MessagePlugin.success("已复制 openid");
  } catch {
    MessagePlugin.error("复制失败，请手动选中复制");
  }
}

// 首次进入自动加载
onMounted(() => load());

// 暴露给父组件（搜索记录拉黑后联动刷新）
defineExpose({ refresh: () => load() });
</script>

<style scoped>
.admin-input-t { flex: 1; min-width: 180px; max-width: 320px; }
.bl-status { width: 130px; }
.bl-alert { border-radius: 8px; }
.bl-pager {
  display: flex;
  justify-content: center;
  padding: 12px 0 4px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}

/* ===== 蜜罐反馈解封区（2026-09-03） ===== */
.hp-wrap {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 14px;
  padding: 14px;
  border: 1px dashed var(--td-component-border, var(--border-light, #e8ecf0));
  border-radius: 10px;
  background: var(--bg-secondary, #fafbfc);
}
.hp-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.hp-form { flex: 1; min-width: 260px; margin: 0; }
.hp-form .admin-input-t { max-width: 420px; }
.hp-alert { border-radius: 8px; }
</style>
