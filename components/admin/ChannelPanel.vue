<template>
  <t-card title="频道管理" :description="cardDesc">
    <template #actions>
      <div class="admin-head-actions">
        <t-button variant="outline" :disabled="loading || saving" @click="load">刷新</t-button>
        <t-button variant="outline" :disabled="loading || saving" @click="askReload">
          {{ reloading ? "重载中…" : "重新加载" }}
        </t-button>
        <t-button theme="primary" :disabled="saving || !dirty" :loading="saving" @click="askSave">
          保存全部
        </t-button>
      </div>
    </template>

    <t-alert v-if="error" theme="error" :message="error" class="channel-alert" />
    <t-alert v-else-if="reloadMsg" theme="success" :message="reloadMsg" class="channel-alert" />

    <!-- 新增频道 -->
    <div class="channel-add">
      <t-input
        v-model="newId"
        class="channel-input"
        placeholder="输入频道 ID（TG 用户名），如 tgsearchers3"
        :disabled="saving"
        clearable
        @enter="addChannel"
      />
      <t-input
        v-model="newDisplay"
        class="channel-input channel-input-sm"
        placeholder="频道名字（备注，可选）"
        :disabled="saving"
        clearable
        @enter="addChannel"
      />
      <t-button variant="outline" :disabled="saving || !newId.trim()" @click="addChannel">
        + 添加频道
      </t-button>
    </div>

    <t-loading :loading="loading" text="加载中…" show-overlay class="channel-body">
      <t-alert
        v-if="dirty"
        theme="warning"
        message="有未保存的修改，点击「保存全部」生效"
        class="channel-alert"
      />
      <p class="channel-tip">
        <b>固定</b>：不下发给第三方站、也不参与本站搜索；<b>搜索</b>：按表格顺序逐批搜索，
        排在前面的频道更早发起请求。可用 ↑↓ 调整搜索顺序。
      </p>

      <t-table
        v-if="rows.length"
        row-key="id"
        :data="rows"
        :columns="columns"
        :max-height="460"
        size="small"
        lazy
      >
        <!-- 固定下发徽章 -->
        <template #pri-slot="{ row }">
          <t-tag :theme="row.priority ? 'primary' : 'default'" variant="light">
            {{ row.priority ? "固定" : "搜索" }}
          </t-tag>
        </template>
        <!-- 频道 ID（不可改） -->
        <template #id-slot="{ row }">
          <span class="channel-id">{{ row.id }}</span>
        </template>
        <!-- 频道名字（备注，可编辑） -->
        <template #name-slot="{ row }">
          <t-input
            v-model="row.name"
            size="small"
            class="row-input"
            placeholder="未备注"
            :disabled="saving"
            :borderless="!row.name"
            @change="onNameInput(row)"
          />
        </template>
        <!-- 操作 -->
        <template #ops-slot="{ row }">
          <div class="ops-cell">
            <template v-if="!row.priority">
              <t-button
                variant="text"
                size="small"
                :disabled="isFirstOfGroup(row)"
                title="上移（搜索更靠前）"
                @click="moveRow(row, -1)">
                ↑
              </t-button>
              <t-button
                variant="text"
                size="small"
                :disabled="isLastOfGroup(row)"
                title="下移（搜索更靠后）"
                @click="moveRow(row, 1)">
                ↓
              </t-button>
            </template>
            <!-- 固定 ⇄ 搜索 切换 -->
            <t-button
              variant="text"
              size="small"
              :title="row.priority ? '取消固定（参与搜索）' : '设为固定（不下发且不参与搜索）'"
              @click="row.priority ? unpick(row.id) : prioritize(row.id)">
              {{ row.priority ? "◁" : "📌" }}
            </t-button>
            <t-button variant="text" theme="danger" size="small" title="删除" @click="askRemove(row.id)">✕</t-button>
          </div>
        </template>
      </t-table>
      <p v-if="rows.length > 12" class="channel-table-hint">↑ 表格内部滚动 · 共 {{ rows.length }} 个频道</p>
      <div v-else-if="rows.length === 0" class="admin-empty">暂无频道</div>
    </t-loading>

    <AdminModal ref="modalRef" :title="'确认操作'" tone="primary" confirm-text="确认" />
  </t-card>
</template>

<script setup lang="ts">
/**
 * 频道管理面板（2026-09-01 TDesign 化：t-table + t-input/t-tag/t-button）
 *
 * 表格列：优先级 / 频道 ID（不可改，即 TG username）/ 频道名字（备注，可编辑）
 *  - 增：顶部输入 ID + 可选名字，添加进默认频道
 *  - 删：操作列 ✕（确认弹窗）
 *  - 改：名字输入框直接编辑、⬆/⬇ 调整搜索顺序、固定 ⇄ 搜索切换
 *  - 查：全量列出（优先在前）
 * 本地编辑 → 批量「保存全部」（PUT 全量，含 channelNames）
 */
import { MessagePlugin } from "tdesign-vue-next";
import { useAdminApi, type ChannelAdminData } from "~/composables/useAdminApi";
import AdminModal from "~/components/admin/AdminModal.vue";

const { loadChannels, saveChannels, reloadChannels } = useAdminApi();
const modalRef = ref<InstanceType<typeof AdminModal>>();

const loading = ref(false);
const saving = ref(false);
const reloading = ref(false);
const error = ref("");
const reloadMsg = ref("");
const dirty = ref(false);
const newId = ref("");
const newDisplay = ref("");

const base = ref<ChannelAdminData | null>(null);

/** 表格行：channel id + 备注名 + 优先级 */
interface ChannelRow {
  id: string;
  name: string; // 备注名（可为空）
  priority: boolean;
}
const rows = ref<ChannelRow[]>([]);

/** t-table 列定义（cell 指向上方具名插槽） */
const columns = [
  { colKey: "priority", title: "固定下发", cell: "pri-slot", width: 96 },
  { colKey: "id", title: "频道 ID", cell: "id-slot", width: 200 },
  { colKey: "name", title: "频道名字", cell: "name-slot" },
  { colKey: "ops", title: "操作", cell: "ops-slot", width: 170 },
];

const version = computed(() => base.value?.version ?? 0);
const allCount = computed(() => rows.value.length);
const priorityCount = computed(() => rows.value.filter((r) => r.priority).length);
const defaultCount = computed(() => rows.value.filter((r) => !r.priority).length);

/** t-card 头部描述 */
const cardDesc = computed(
  () => `全部频道 ${allCount.value} 个 · 固定 ${priorityCount.value} + 搜索 ${defaultCount.value} · 版本 v${version.value || "-"}`,
);

/** 从后端数据构建表格行 */
function buildRows(data: ChannelAdminData): ChannelRow[] {
  const names = data.channelNames ?? {};
  const pri = data.priorityChannels.map((id) => ({ id, name: names[id] ?? "", priority: true }));
  const def = data.defaultChannels.map((id) => ({ id, name: names[id] ?? "", priority: false }));
  return [...pri, ...def];
}

/** 加载服务器最新配置 */
async function load() {
  loading.value = true;
  error.value = "";
  reloadMsg.value = "";
  try {
    const data = await loadChannels();
    base.value = data;
    rows.value = buildRows(data);
    dirty.value = false;
  } catch (e: any) {
    error.value = e?.message || "请求异常";
  } finally {
    loading.value = false;
  }
}

/** 增：添加到默认频道 */
function addChannel() {
  const id = newId.value.trim();
  if (!id) return;
  if (rows.value.some((r) => r.id === id)) {
    MessagePlugin.error("该频道已存在");
    return;
  }
  rows.value.push({ id, name: newDisplay.value.trim(), priority: false });
  newId.value = "";
  newDisplay.value = "";
  dirty.value = true;
}

/** 删：确认弹窗后移除 */
function askRemove(id: string) {
  const row = rows.value.find((r) => r.id === id);
  modalRef.value?.open({
    title: "删除频道",
    message: `确定删除频道「${row?.name || id}」（${id}）吗？保存后对所有使用该频道列表的请求生效。`,
    tone: "danger",
    confirmText: "删除",
    onConfirm: async () => {
      rows.value = rows.value.filter((r) => r.id !== id);
      dirty.value = true;
    },
  });
}

/** 备注输入时标记脏 */
function onNameInput(_row: ChannelRow) {
  dirty.value = true;
}

/** 设为固定（移到固定组末尾） */
function prioritize(id: string) {
  const row = rows.value.find((r) => r.id === id);
  if (row) row.priority = true;
  sortRows();
  dirty.value = true;
}
/** 取消固定（移到搜索组末尾，即最后搜） */
function unpick(id: string) {
  const row = rows.value.find((r) => r.id === id);
  if (row) row.priority = false;
  sortRows();
  dirty.value = true;
}

/** 保持固定在前、搜索在后（组内相对顺序不变；稳定排序） */
function sortRows() {
  rows.value = [...rows.value].sort((a, b) => Number(b.priority) - Number(a.priority));
}

/** 搜索组内第一个 / 最后一个？ */
function isFirstOfGroup(row: ChannelRow): boolean {
  const group = rows.value.filter((r) => !r.priority);
  return group.length <= 1 || group[0].id === row.id;
}
function isLastOfGroup(row: ChannelRow): boolean {
  const group = rows.value.filter((r) => !r.priority);
  return group.length <= 1 || group[group.length - 1].id === row.id;
}

/** 搜索组内上移/下移（数组顺序 = 搜索顺序） */
function moveRow(row: ChannelRow, dir: -1 | 1) {
  const idx = rows.value.findIndex((r) => r.id === row.id);
  if (idx < 0) return;
  const next = idx + dir;
  // 只能在同一组内移动：不能越过固定/搜索的分界
  if (next < 0 || next >= rows.value.length) return;
  const target = rows.value[next];
  if (target.priority !== row.priority) return; // 跨组不允许
  const copy = [...rows.value];
  copy[idx] = target;
  copy[next] = row;
  rows.value = copy;
  dirty.value = true;
}

/** 保存全部 */
function askSave() {
  modalRef.value?.open({
    title: "保存频道配置",
    message: `将保存为 v${version.value + 1}：固定下发 ${priorityCount.value} 个、参与搜索 ${defaultCount.value} 个。\n保存后立即对所有请求生效。`,
    confirmText: "保存",
    onConfirm: async () => {
      await doSave();
    },
  });
}

async function doSave() {
  if (saving.value) return;
  saving.value = true;
  error.value = "";
  reloadMsg.value = "";
  try {
    // 组装 channelNames（仅保留非空备注）
    const channelNames: Record<string, string> = {};
    for (const r of rows.value) {
      const name = r.name.trim();
      if (name) channelNames[r.id] = name;
    }
    const r = await saveChannels({
      priorityChannels: rows.value.filter((x) => x.priority).map((x) => x.id),
      defaultChannels: rows.value.filter((x) => !x.priority).map((x) => x.id),
      channelNames,
    });
    dirty.value = false;
    MessagePlugin.success(`已保存 v${r.version}`);
    await load(); // 服务端做了去重/互斥，回读最新
  } catch (e: any) {
    MessagePlugin.error(e?.message || "保存失败");
    throw e; // 保持弹窗显示错误
  } finally {
    saving.value = false;
  }
}

/** 重新加载（放弃本地修改，从远端重拉） */
function askReload() {
  modalRef.value?.open({
    title: "重新加载频道配置",
    message: dirty.value
      ? "当前有未保存的修改，重新加载将丢弃这些修改，从远端拉取最新频道。\n确定继续吗？"
      : "将重新从远端拉取最新频道清单。\n确定继续吗？",
    confirmText: "重新加载",
    onConfirm: async () => {
      if (reloading.value) return;
      reloading.value = true;
      try {
        const r = await reloadChannels();
        await load();
        reloadMsg.value = `已重载：版本 ${r.version ?? "-"}，默认 ${r.defaultCount} + 优先 ${r.priorityCount} 个频道`;
        MessagePlugin.success("频道配置已重载");
      } catch (e: any) {
        MessagePlugin.error(e?.message || "重载失败");
        throw e;
      } finally {
        reloading.value = false;
      }
    },
  });
}

onMounted(load);
</script>

<style scoped>
.admin-head-actions { display: flex; gap: 8px; align-items: center; }
.channel-alert { border-radius: 8px; }
.channel-add {
  display: flex;
  gap: 10px;
  margin: 16px 0 14px;
}
.channel-input { flex: 1; min-width: 0; }
.channel-input-sm { max-width: 220px; }
.channel-body { min-height: 120px; border-radius: 10px; }

.channel-tip {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-tertiary, #9ca3af);
  background: var(--bg-hover, rgba(37, 99, 235, 0.04));
  border-radius: 8px;
  padding: 8px 12px;
}
.channel-tip b { color: var(--text-secondary, #4b5563); font-weight: 600; }

.channel-id {
  color: var(--text-secondary, #475569);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  word-break: break-all;
}
.row-input { width: 100%; max-width: 280px; }
.ops-cell {
  display: flex;
  align-items: center;
  gap: 2px;
}
.channel-table-hint {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-tertiary, #9ca3af);
}
.admin-empty { padding: 24px 0; text-align: center; color: var(--text-tertiary, #9ca3af); font-size: 14px; }
</style>
