<template>
  <t-card title="搜索记录" description="谁搜了什么 / 某词谁搜过。可对异常 IP 一键加入黑名单。">

    <!-- 查询表单 -->
    <form class="admin-form" @submit.prevent="doSearch">
      <t-radio-group v-model="mode" variant="default-filled" class="sr-mode">
        <t-radio-button value="openid">按 openid 查</t-radio-button>
        <t-radio-button value="term">按搜索词查</t-radio-button>
        <t-radio-button value="ip">按 IP 查</t-radio-button>
      </t-radio-group>
      <div class="admin-form-row">
        <t-input
          v-model="keyword"
          class="admin-input-t"
          :placeholder="mode === 'openid' ? '输入 openid' : mode === 'term' ? '输入搜索词' : '输入 IP'"
          clearable
          @enter="doSearch" />
        <t-select v-model="days" class="sr-days" aria-label="时间范围">
          <t-option value="1" label="近 1 天" />
          <t-option value="7" label="近 7 天" />
          <t-option value="30" label="近 30 天" />
          <t-option value="90" label="近 90 天" />
        </t-select>
        <t-button theme="primary" :disabled="loading || !keyword.trim()" :loading="loading" @click="doSearch">
          查询
        </t-button>
      </div>
    </form>

    <t-alert v-if="error" theme="error" :message="error" class="sr-alert" />

    <!-- 结果区 -->
    <template v-if="searched">
      <div class="admin-list-head">
        <span>共 {{ total }} 条记录（{{ modeLabel }}：{{ lastKeyword }}）</span>
      </div>

      <t-loading :loading="loading" text="查询中…" show-overlay>
        <t-table
          v-if="items.length > 0"
          row-key="_idx"
          :data="items"
          :columns="tableColumns"
          :max-height="520"
          size="small"
        >
          <template #op-slot="{ row }">
            <t-button
              v-if="row.ip"
              theme="danger"
              variant="outline"
              size="small"
              :loading="busyKey === `block-${row.ip}`"
              @click="askBlock(row.ip)">
              拉黑
            </t-button>
            <span v-else class="admin-hint">-</span>
          </template>
        </t-table>
        <div v-else class="admin-state">无记录（该时间范围内没有数据）</div>

        <!-- 分页（change 回调参数是 PageInfo 对象，取 current） -->
        <t-pagination
          v-if="totalPages > 1"
          class="sr-pager"
          :current="page"
          :page-size="PAGE_SIZE"
          :total="total"
          :show-page-size="false"
          :show-jumper="false"
          :disabled="loading"
          @change="(info: any) => goPage(info.current)"
        />
      </t-loading>
    </template>

    <!-- 确认弹窗（确认后执行拉黑） -->
    <AdminModal ref="modal" title="拉黑 IP" tone="danger" confirm-text="确认拉黑" />
  </t-card>
</template>

<script setup lang="ts">
/**
 * 搜索记录面板（2026-09-01 TDesign 化：t-table + t-pagination + t-radio-group）
 * 查询 /api/search-log：按 openid / 按词 / 按 IP；结果行内"拉黑"调 /api/blacklist。
 */
import { MessagePlugin } from "tdesign-vue-next";
import { useAdminApi, type SearchLogItem } from "~/composables/useAdminApi";
import AdminModal from "~/components/admin/AdminModal.vue";

const { querySearchLog, blockIp } = useAdminApi();
const modal = ref<InstanceType<typeof AdminModal>>();

const mode = ref<"openid" | "term" | "ip">("openid");
const keyword = ref("");
const days = ref("7");
const loading = ref(false);
const error = ref("");
const items = ref<SearchLogItem[]>([]);
const total = ref(0);
const searched = ref(false);
const lastKeyword = ref("");
const busyKey = ref("");
const page = ref(1);
const PAGE_SIZE = 50;
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));

/** 通知父层黑名单数据已变化（拉黑后联动刷新黑名单面板） */
const emit = defineEmits<{ (e: "blocked"): void }>();
const modeLabel = computed(() =>
  mode.value === "openid" ? "openid" : mode.value === "term" ? "搜索词" : "IP",
);

/** t-table 列：openid 列只在按词/IP 查时展示 */
const tableColumns = computed(() => {
  const cols: any[] = [
    { colKey: "term", title: "搜索词", cell: (_h: any, { row }: any) => row.term ?? "-", ellipsis: true },
  ];
  if (mode.value !== "openid") {
    cols.push({ colKey: "openid", title: "openid", cell: (_h: any, { row }: any) => row.openid ?? "-", ellipsis: true });
  }
  cols.push(
    { colKey: "ip", title: "IP", cell: (_h: any, { row }: any) => row.ip || "-" },
    { colKey: "time", title: "时间（北京时间）", cell: (_h: any, { row }: any) => formatTime(row.createdAt) },
    { colKey: "ops", title: "操作", cell: "op-slot", width: 90 },
  );
  return cols;
});

function formatTime(ms?: number): string {
  if (!ms) return "-";
  const d = new Date(ms + 8 * 3600 * 1000); // 北京时间
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

async function doSearch() {
  const kw = keyword.value.trim();
  if (!kw) return;
  page.value = 1;
  await doQuery();
}

async function doQuery() {
  const kw = keyword.value.trim();
  if (!kw) return;
  loading.value = true;
  error.value = "";
  try {
    const data = await querySearchLog({
      mode: mode.value,
      keyword: kw,
      days: days.value,
      limit: PAGE_SIZE,
      offset: (page.value - 1) * PAGE_SIZE,
    });
    items.value = (data.items ?? []).map((it, idx) => ({ ...it, _idx: idx }));
    total.value = data.total ?? items.value.length;
    lastKeyword.value = kw;
    searched.value = true;
  } catch (e: any) {
    error.value = e?.message || "请求异常";
  } finally {
    loading.value = false;
  }
}

function goPage(p: number) {
  if (typeof p !== "number" || p < 1 || p > totalPages.value) return;
  page.value = p;
  doQuery();
}

/** 弹确认框，确认后执行拉黑 */
function askBlock(ip: string) {
  modal.value?.open({
    title: "拉黑 IP",
    message: `确定将 IP ${ip} 加入黑名单？\n立即封禁 30 天，该 IP 的搜索请求将被拦截。`,
    onConfirm: async () => {
      await doBlock(ip);
    },
  });
}

async function doBlock(ip: string) {
  if (busyKey.value) return;
  busyKey.value = `block-${ip}`;
  try {
    await blockIp(ip, "manual");
    // 本页剔除该 IP；若本页删空且非第 1 页则回退一页，再刷新
    items.value = items.value.filter((it) => it.ip !== ip);
    total.value = Math.max(0, total.value - 1);
    if (items.value.length === 0 && page.value > 1) page.value -= 1;
    MessagePlugin.success(`已拉黑 ${ip}`);
    emit("blocked");
    await doQuery();
  } catch (e: any) {
    MessagePlugin.error(e?.message || "拉黑失败");
    throw e; // 让 modal 保持打开显示错误
  } finally {
    busyKey.value = "";
  }
}
</script>

<style scoped>
.sr-mode { margin-bottom: 4px; }
.admin-input-t { flex: 1; min-width: 180px; max-width: 420px; }
.sr-days { width: 130px; }
.sr-alert { border-radius: 8px; }
.sr-pager {
  display: flex;
  justify-content: center;
  padding: 12px 0 4px;
}
</style>
