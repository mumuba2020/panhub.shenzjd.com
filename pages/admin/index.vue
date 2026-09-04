<script setup lang="ts">
/**
 * PanHub 管理面板（2026-09-02 瘦身：鉴权门已上收到 layouts/admin.vue）
 *
 * 布局层负责探测登录/管理员状态并渲染侧栏；能挂载到本页时鉴权必已通过，
 * 本页只做一件事：根据 activeKey（布局注入）渲染对应面板。
 */
import { ADMIN_NAV_KEY } from "~/utils/adminKeys";
import OverviewPanel from "~/components/admin/OverviewPanel.vue";
import SearchRecordPanel from "~/components/admin/SearchRecordPanel.vue";
import BlacklistPanel from "~/components/admin/BlacklistPanel.vue";
import ChannelPanel from "~/components/admin/ChannelPanel.vue";

definePageMeta({
  title: "PanHub 管理",
  layout: "admin",
});
useSeoMeta({
  title: "PanHub 管理",
  robots: "noindex,nofollow", // 管理页禁止收录
});

/** 布局注入的当前激活菜单（响应式） */
const nav = inject<{ activeKey: Ref<string>; setActive: (k: string) => void }>(ADMIN_NAV_KEY);
const activeKey = computed(() => nav?.activeKey.value ?? "overview");

/** 面板联动：搜索记录里拉黑后，通知黑名单面板刷新（若已挂载） */
const blPanel = ref<InstanceType<typeof BlacklistPanel>>();
function onBlocked() {
  blPanel.value?.refresh?.();
}
</script>

<template>
  <div class="admin-page">
    <OverviewPanel v-if="activeKey === 'overview'" />
    <ChannelPanel v-else-if="activeKey === 'channels'" />
    <SearchRecordPanel v-else-if="activeKey === 'search-log'" @blocked="onBlocked" />
    <BlacklistPanel v-else-if="activeKey === 'blacklist'" ref="blPanel" />
  </div>
</template>
