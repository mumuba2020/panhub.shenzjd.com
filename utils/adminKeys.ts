/**
 * 管理后台 provide/inject 常量（2026-08-25 规范化重构）
 * 布局 layouts/admin.vue 与页面 pages/admin/index.vue 通过注入键协作，
 * 键集中在此处，避免魔法字符串。
 */
export const ADMIN_NAV_KEY = Symbol("admin-nav") as InjectionKey<{
  activeKey: Ref<string>;
  setActive: (k: string) => void;
}>;