<script setup lang="ts">
/**
 * /s/[term] 已废弃为独立搜索页 —— 统一重定向到首页 /?q=xxx 复用首页搜索体验。
 *
 * 原因：
 * 1. 原实现用 fetch(/api/search?res=merged_by_type) 一次性等所有插件返回，体验极慢；
 *    首页 useSearch 是流式渐进渲染，且带用户设置/暂停续搜等完整能力。
 * 2. /s/[term] 是动态参数页，搜索引擎几乎无法批量收录，SEO 价值极低，反而分流用户。
 *
 * server 端由 nuxt.config.ts routeRules 直接 301 到 /?q=xxx（Nitro 层，不渲染本组件）；
 * 本组件仅作为客户端导航兜底（vue-router 的 redirect 记录），保证任何入口都不出现 404 或加载圈。
 */
definePageMeta({
  redirect: (route) => {
    let raw = String(route.params.term || "");
    let term = raw;
    try {
      // 兼容已编码/未编码两种形式，避免双重编码
      term = decodeURIComponent(raw);
    } catch {}
    term = term.trim().slice(0, 50);
    if (!term) return "/";
    return `/?q=${encodeURIComponent(term)}`;
  },
});
</script>

<template>
  <div />
</template>
