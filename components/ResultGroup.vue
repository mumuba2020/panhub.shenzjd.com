<template>
  <div class="result-card" data-theme-part="result-card">
    <!-- 卡片头部 -->
    <div class="card-header" data-theme-part="card-header">
      <div class="platform-badge" :style="{ background: color }">
        <img class="platform-icon" :src="icon" :alt="title" />
      </div>
      <div class="header-info">
        <h3 class="platform-title">{{ title }}</h3>
        <span class="resource-count">{{ items.length }} 个资源</span>
      </div>
      <button
        v-if="canToggleCollapse && !expanded && items.length > initialVisible"
        class="expand-btn"
        @click="$emit('toggle')">
        展开
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M6 9l6 6 6-6"></path>
        </svg>
      </button>
    </div>

    <!-- 资源列表 -->
    <ul class="resource-list">
      <li v-for="r in visibleItems" :key="r.url" class="resource-item">
        <div class="resource-content">
          <a
            class="resource-link"
            :class="{ 'resource-link--dead': linkStatus(r) === 'bad' }"
            :href="r.url"
            target="_blank"
            rel="noopener noreferrer nofollow"
            :title="r.note || r.url">
            <span class="link-text">{{ r.note || r.url }}</span>
            <svg class="external-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
              <polyline points="15 3 21 3 21 9"></polyline>
              <line x1="10" y1="14" x2="21" y2="3"></line>
            </svg>
          </a>

          <div class="resource-meta">
            <div class="meta-tags">
              <span class="meta-tag date">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                  <line x1="16" y1="2" x2="16" y2="6"></line>
                  <line x1="8" y1="2" x2="8" y2="6"></line>
                  <line x1="3" y1="10" x2="21" y2="10"></line>
                </svg>
                {{ formatDate(r.datetime) || "时间未知" }}
              </span>

              <span v-if="r.password" class="meta-tag password">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                  <circle cx="12" cy="16" r="1"></circle>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                </svg>
                提取码: {{ r.password }}
              </span>

              <!-- 服务端探活结果角标（异步懒查，不阻塞渲染） -->
              <span v-if="linkStatus(r) === 'bad'" class="meta-tag dead">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
                已失效
              </span>
              <span v-else-if="linkStatus(r) === 'locked'" class="meta-tag locked">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                  <circle cx="12" cy="16" r="1"></circle>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                </svg>
                需密码
              </span>
            </div>

            <button
              class="copy-btn"
              :class="{ 'copy-btn--copied': copiedUrl === r.url }"
              @click.prevent="handleCopy(r.url)"
              :title="copiedUrl === r.url ? '已复制' : '复制链接'">
              <svg v-if="copiedUrl !== r.url" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
              <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
              {{ copiedUrl === r.url ? '已复制' : '复制' }}
            </button>
          </div>
        </div>
      </li>
    </ul>

    <!-- 底部展开按钮 -->
    <div v-if="!expanded && items.length > initialVisible" class="card-footer" data-theme-part="card-footer">
      <button class="load-more-btn" @click="$emit('toggle')">
        显示更多 ({{ items.length - initialVisible }})
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 5v14M5 12l7 7 7-7"></path>
        </svg>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  title: string;
  color: string;
  icon: string;
  items: any[];
  expanded: boolean;
  initialVisible: number;
  canToggleCollapse?: boolean;
}>();
const emit = defineEmits(["toggle", "copy"]);

const copiedUrl = ref("");
let copyTimer: ReturnType<typeof setTimeout> | null = null;

// 链接有效性检测（服务端探活，异步懒查当前可见链接）
const { enqueue, statusOf } = useLinkCheck();

// 注意：visibleItems 必须先于下方 watch 声明——
// watch({ immediate: true }) 会在 setup 执行到 watch 行时立即求值 getter，
// 若声明在后会触发 TDZ ReferenceError: Cannot access 'visibleItems' before initialization
// （曾导致整个组件挂载失败、搜索结果列表空白）
const visibleItems = computed(() =>
  props.expanded ? props.items : props.items.slice(0, props.initialVisible)
);

function linkStatus(r: any) {
  return statusOf(r.url)?.status;
}

watch(
  () => visibleItems.value,
  (items) => {
    if (!items || items.length === 0) return;
    enqueue(
      items.map((r) => ({
        url: typeof r.url === "string" ? r.url : "",
        password: typeof r.password === "string" ? r.password : "",
      }))
    );
  },
  { immediate: true }
);

function handleCopy(url: string) {
  emit("copy", url);
  copiedUrl.value = url;
  if (copyTimer) clearTimeout(copyTimer);
  copyTimer = setTimeout(() => { copiedUrl.value = ""; }, 1500);
}

function formatDate(d?: string) {
  if (!d) return "";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return "";
  const now = Date.now();
  const diff = now - dt.getTime();
  const days = Math.floor(diff / 86400000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 30) return `${days}天前`;
  if (days < 365) return `${Math.floor(days / 30)}个月前`;
  return dt.toLocaleDateString("zh-CN");
}
</script>

<style scoped>
/* 结果卡片主体：实色底（2026-09-04 滚动性能优化）。
   此前半透明 + backdrop-filter: blur(8px) 叠加 app.vue 常驻动画光斑背景，
   视口内每张卡片每帧都被强制重新采样模糊，是结果页滚动掉帧的主因。
   改实色后卡片零合成成本，视觉几乎无损（背后本就是静态渐变光斑） */
.result-card {
  background: var(--bg-primary);
  border: 1px solid var(--border-light);
  border-radius: 16px;
  box-shadow: 0 8px 22px rgba(17, 24, 39, 0.06);
  overflow: hidden;
  transition: box-shadow var(--transition-normal), transform var(--transition-normal),
    border-color var(--transition-normal);
}

.result-card:hover {
  box-shadow: 0 14px 28px rgba(17, 24, 39, 0.1);
  transform: translateY(-3px);
}

/* 卡片头部 */
.card-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  background: var(--bg-surface-elevated);
  border-bottom: 1px solid var(--border-light);
  position: relative;
}

.card-header::after {
  content: "";
  position: absolute;
  bottom: 0;
  left: 16px;
  right: 16px;
  height: 1px;
  background: linear-gradient(90deg, var(--primary), transparent 70%);
  opacity: 0.25;
}

/* 平台徽章 */
.platform-badge {
  width: 36px;
  height: 36px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-size: 16px;
  font-weight: 700;
  box-shadow: 0 5px 10px rgba(17, 24, 39, 0.2);
  flex-shrink: 0;
}

.platform-icon {
  width: 22px;
  height: 22px;
  object-fit: contain;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.2));
}

/* 头部信息 */
.header-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.platform-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0;
  line-height: 1.2;
}

.resource-count {
  font-size: 12px;
  color: var(--text-tertiary);
  font-weight: 500;
}

/* 展开按钮 */
.expand-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  background: transparent;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color var(--transition-fast), border-color var(--transition-fast),
    color var(--transition-fast), transform var(--transition-fast);
  white-space: nowrap;
}

.expand-btn:hover {
  background: var(--bg-secondary);
  border-color: var(--border-medium);
  color: var(--text-primary);
  transform: translateY(-1px);
}

.expand-btn svg {
  stroke: currentColor;
}

/* 资源列表：自然撑开，不做内层滚动（2026-09-04）。
   此前 max-height:600px + overflow-y:auto 让每张卡片成为嵌套滚动容器，
   触控板手势先被内层消费、到边界才链到外层，滚动体感顿挫；
   配合"显示更多"折叠（默认仅 3 条）整页保持单一滚动容器 */
.resource-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

/* 单个资源项 */
.resource-item {
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-light);
  transition: background var(--transition-fast);
}

.resource-item:last-child {
  border-bottom: none;
}

.resource-item:hover {
  background: var(--bg-hover);
}

.resource-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 资源链接 */
.resource-link {
  display: flex;
  align-items: center;
  gap: 6px;
  text-decoration: none;
  color: var(--primary);
  font-weight: 600;
  font-size: 14px;
  line-height: 1.4;
  transition: color var(--transition-fast), gap var(--transition-fast);
  word-break: break-word;
  overflow-wrap: anywhere;
}

.resource-link:hover {
  color: var(--primary-dark);
  gap: 8px;
}

.link-text {
  flex: 1;
  min-width: 0;
}

.external-icon {
  opacity: 0;
  transform: translateX(-4px);
  transition: opacity var(--transition-fast), transform var(--transition-fast);
  flex-shrink: 0;
}

.resource-link:hover .external-icon {
  opacity: 1;
  transform: translateX(0);
}

.external-icon {
  stroke: currentColor;
}

/* 资源元数据 */
.resource-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.meta-tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  flex: 1;
}

/* 元数据标签 */
.meta-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  border-radius: 999px;
  font-size: 11px;
  color: var(--text-secondary);
  font-weight: 500;
}

.meta-tag svg {
  stroke: currentColor;
  opacity: 0.7;
}

.meta-tag.date {
  background: rgba(99, 102, 241, 0.08);
  border-color: rgba(99, 102, 241, 0.15);
  color: var(--primary);
}

.meta-tag.password {
  background: rgba(16, 185, 129, 0.1);
  border-color: rgba(16, 185, 129, 0.2);
  color: var(--success);
}

/* 失效角标（红） */
.meta-tag.dead {
  background: rgba(239, 68, 68, 0.1);
  border-color: rgba(239, 68, 68, 0.25);
  color: #ef4444;
}

/* 需密码角标（橙） */
.meta-tag.locked {
  background: rgba(245, 158, 11, 0.12);
  border-color: rgba(245, 158, 11, 0.25);
  color: #f59e0b;
}

/* 失效链接：删除线 + 弱化 */
.resource-link--dead {
  text-decoration: line-through;
  text-decoration-color: #ef4444;
  text-decoration-thickness: 1.5px;
  opacity: 0.6;
}

/* 复制按钮 */
.copy-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  background: transparent;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color var(--transition-fast), border-color var(--transition-fast),
    color var(--transition-fast), transform var(--transition-fast);
  white-space: nowrap;
}

.copy-btn:hover {
  background: var(--bg-secondary);
  border-color: var(--border-medium);
  color: var(--text-primary);
  transform: translateY(-1px);
}

.copy-btn:active {
  transform: translateY(0);
  background: var(--border-light);
}

.copy-btn svg {
  stroke: currentColor;
}

.copy-btn--copied {
  color: var(--success);
  border-color: var(--success);
}

/* 卡片底部 */
.card-footer {
  padding: 12px 16px;
  background: var(--bg-surface-subtle);
  border-top: 1px solid var(--border-light);
  text-align: center;
}

.load-more-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: linear-gradient(135deg, var(--primary), #14b8a6);
  color: white;
  border: none;
  border-radius: var(--radius-md);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: transform var(--transition-fast), box-shadow var(--transition-fast);
  box-shadow: 0 4px 12px rgba(15, 118, 110, 0.3);
}

.load-more-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 16px rgba(15, 118, 110, 0.4);
}

.load-more-btn:active {
  transform: translateY(0);
}

.load-more-btn svg {
  stroke: currentColor;
}

/* 移动端优化 */
@media (max-width: 640px) {
  .card-header {
    padding: 12px;
    gap: 10px;
  }

  .platform-badge {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    font-size: 14px;
  }

  .platform-title {
    font-size: 15px;
  }

  .resource-item {
    padding: 12px;
  }

  .resource-link {
    font-size: 13px;
  }

  .meta-tag {
    padding: 3px 6px;
    font-size: 10px;
  }

  .copy-btn {
    padding: 5px 8px;
    font-size: 11px;
  }

  .expand-btn {
    padding: 5px 8px;
    font-size: 11px;
  }

  .load-more-btn {
    padding: 8px 12px;
    font-size: 13px;
  }
}

/* 高对比度模式支持 */
@media (prefers-contrast: high) {
  .result-card {
    border-width: 2px;
  }

  .platform-badge {
    border: 2px solid white;
  }

  .meta-tag {
    border-width: 2px;
  }

  .copy-btn,
  .expand-btn,
  .load-more-btn {
    border-width: 2px;
  }
}

/* 减少动画模式支持 */
@media (prefers-reduced-motion: reduce) {
  .result-card,
  .resource-item,
  .resource-link,
  .expand-btn,
  .copy-btn,
  .load-more-btn {
    transition: none;
  }

  .result-card:hover,
  .resource-link:hover,
  .expand-btn:hover,
  .copy-btn:hover,
  .load-more-btn:hover {
    transform: none;
  }

  .external-icon {
    transition: none;
  }
}
</style>
