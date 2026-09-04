// 平台信息配置 — icon 为官方 favicon 图片路径
export const PLATFORM_INFO: Record<
  string,
  { name: string; color: string; icon: string }
> = {
  aliyun: { name: "阿里云盘", color: "#7c3aed", icon: "/icons/aliyun.png" },
  quark: { name: "夸克网盘", color: "#6366f1", icon: "/icons/quark.png" },
  baidu: { name: "百度网盘", color: "#2563eb", icon: "/icons/baidu.png" },
  "115": { name: "115网盘", color: "#f59e0b", icon: "/icons/115.png" },
  xunlei: { name: "迅雷云盘", color: "#fbbf24", icon: "/icons/xunlei.png" },
  uc: { name: "UC网盘", color: "#ef4444", icon: "/icons/uc.png" },
  tianyi: { name: "天翼云盘", color: "#ec4899", icon: "/icons/tianyi.png" },
  "123": { name: "123网盘", color: "#10b981", icon: "/icons/123.png" },
  mobile: { name: "移动云盘", color: "#0ea5e9", icon: "/icons/mobile.png" },
  others: { name: "其他网盘", color: "#6b7280", icon: "/icons/others.png" },
  magnet: { name: "磁力链接", color: "#22c55e", icon: "/icons/magnet.png" },
};

// 默认用户设置（仅并发/超时；搜索源全在后端，前端不再配置）
export const DEFAULT_USER_SETTINGS = {
  concurrency: 4,
  pluginTimeoutMs: 5000,
} as const;
