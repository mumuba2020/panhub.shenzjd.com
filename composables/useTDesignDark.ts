/**
 * TDesign 深色模式同步（2026-09-01）
 *
 * TDesign 组件不认全站的 .dark class，需要在 <html> 上设置
 * theme-mode="dark" 属性才会切换主题。admin 相关布局（layouts/admin.vue、
 * layouts/admin-auth.vue）挂载时调用本 composable，跟随系统偏好双向同步，
 * 与全站 useDarkMode（prefers-color-scheme → .dark class）保持同源。
 */
export function useTDesignDark() {
  let darkMq: MediaQueryList | null = null;

  function sync(e: MediaQueryList | MediaQueryListEvent) {
    if (e.matches) {
      document.documentElement.setAttribute("theme-mode", "dark");
    } else {
      document.documentElement.removeAttribute("theme-mode");
    }
  }

  onMounted(() => {
    darkMq = window.matchMedia("(prefers-color-scheme: dark)");
    sync(darkMq);
    darkMq.addEventListener("change", sync);
  });

  onBeforeUnmount(() => {
    darkMq?.removeEventListener("change", sync);
  });
}
