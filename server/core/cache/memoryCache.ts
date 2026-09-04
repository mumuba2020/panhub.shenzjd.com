type CacheRecord<T> = { value: T; expireAt: number; size: number };

export interface MemoryCacheOptions {
  maxSize?: number;
  maxMemoryBytes?: number;
  cleanupInterval?: number;
  memoryThreshold?: number;
}

export interface MemoryCacheStats {
  total: number;
  active: number;
  expired: number;
  maxSize: number;
  memoryBytes: number;
  maxMemoryBytes: number;
  memoryUsagePercent: number;
  hits: number;
  misses: number;
  evictions: number;
}

/**
 * 高性能 LRU 内存缓存
 *
 * - Map 插入序即 LRU 序：访问时 delete+re-insert 移到末尾，淘汰从头部取 O(1)
 * - 增量追踪内存：set/remove 时增减 totalMemoryBytes，不再遍历
 * - 快速 size 估算：不用 JSON.stringify
 * - 仅 set() 触发周期清理，get() 只清理被访问的那个过期 key
 */
export class MemoryCache<T = unknown> {
  private store = new Map<string, CacheRecord<T>>();
  private totalMemoryBytes = 0;
  private lastCleanup = 0;
  private metrics = { hits: 0, misses: 0, evictions: 0 };
  private options: Required<MemoryCacheOptions>;

  constructor(options: MemoryCacheOptions = {}) {
    this.options = {
      maxSize: options.maxSize ?? 300,
      maxMemoryBytes: options.maxMemoryBytes ?? 64 * 1024 * 1024,
      cleanupInterval: options.cleanupInterval ?? 5 * 60 * 1000,
      memoryThreshold: options.memoryThreshold ?? 0.8,
    };
  }

  /**
   * 递归估算值占用的近似内存（字节）。
   * 修正（2026-08-20 恢复 84c5f3a）：旧实现嵌套数组按 length*64 估算，对
   * SearchResult[] 这类对象数组严重低估（每条含 links/title/content 等字段，
   * 真实占用是估算的几十倍），导致 maxMemoryBytes 形同虚设、缓存实际吃掉
   * 数 GB 内存（2GB 无 swap 小机 OOM 的根因之一）。
   * 新实现递归到字段级，估算接近真实占用；搜索同一关键词重复率低，缓存
   * 收益有限，按真实大小收紧上限（300 条 / 64MB，适配容器 768m 限制）。
   */
  private fastEstimate(value: unknown): number {
    return this.estimateAny(value, 0);
  }

  private estimateAny(value: unknown, depth: number): number {
    if (value === null || value === undefined) return 8;
    if (typeof value === "string") return value.length * 2 + 8;
    if (typeof value === "number") return 8;
    if (typeof value === "boolean") return 4;
    if (typeof value === "object") {
      // 防过深/循环引用：超过 4 层按定值计（SearchResult 结构最深约 3 层）
      if (depth > 4) return 128;
      if (Array.isArray(value)) {
        if (value.length === 0) return 16;
        return value.length * this.estimateAny(value[0], depth + 1) + 16;
      }
      let total = 16;
      for (const key in value as Record<string, unknown>) {
        total +=
          key.length * 2 + 16 + this.estimateAny((value as any)[key], depth + 1);
      }
      return total;
    }
    return 64;
  }

  private removeEntry(key: string, rec: CacheRecord<T>): void {
    this.store.delete(key);
    this.totalMemoryBytes -= rec.size;
  }

  /** O(1) LRU 淘汰：Map 第一个 entry 即最旧 */
  private evictOne(): void {
    const firstKey = this.store.keys().next().value;
    if (firstKey !== undefined) {
      const rec = this.store.get(firstKey)!;
      this.removeEntry(firstKey, rec);
      this.metrics.evictions++;
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, rec] of this.store) {
      if (rec.expireAt <= now) {
        this.removeEntry(key, rec);
      }
    }
  }

  /** 仅 set() 调用：按 cleanupInterval 周期清理 */
  private maybeCleanup(): void {
    const now = Date.now();
    if (now - this.lastCleanup < this.options.cleanupInterval) return;
    this.lastCleanup = now;
    this.cleanup();
  }

  get(key: string): { hit: boolean; value?: T } {
    const rec = this.store.get(key);
    if (!rec) {
      this.metrics.misses++;
      return { hit: false };
    }

    if (rec.expireAt <= Date.now()) {
      this.removeEntry(key, rec);
      this.metrics.misses++;
      return { hit: false };
    }

    // LRU refresh: delete + re-insert 移到末尾 O(1)
    this.store.delete(key);
    this.store.set(key, rec);
    this.metrics.hits++;
    return { hit: true, value: rec.value };
  }

  set(key: string, value: T, ttlMs: number): void {
    this.maybeCleanup();

    const existing = this.store.get(key);
    if (existing) {
      this.removeEntry(key, existing);
    }

    const size = this.fastEstimate(value);
    const record: CacheRecord<T> = {
      value,
      expireAt: Date.now() + Math.max(0, ttlMs),
      size,
    };

    // 淘汰直到有空间
    while (
      (this.store.size >= this.options.maxSize ||
        this.totalMemoryBytes + size > this.options.maxMemoryBytes) &&
      this.store.size > 0
    ) {
      this.evictOne();
    }

    this.store.set(key, record);
    this.totalMemoryBytes += size;
  }

  delete(key: string): void {
    const rec = this.store.get(key);
    if (rec) this.removeEntry(key, rec);
  }

  /** 按前缀批量删除（管理端写操作失效对应面板缓存用），返回删除条数 */
  deletePrefix(prefix: string): number {
    let removed = 0;
    for (const [key, rec] of this.store) {
      if (key.startsWith(prefix)) {
        this.removeEntry(key, rec);
        removed++;
      }
    }
    return removed;
  }

  clear(): void {
    this.store.clear();
    this.totalMemoryBytes = 0;
    this.metrics = { hits: 0, misses: 0, evictions: 0 };
  }

  get size(): number {
    return this.store.size;
  }

  get memoryUsage(): number {
    return this.totalMemoryBytes;
  }

  getStats(): MemoryCacheStats {
    const now = Date.now();
    let active = 0;
    let expired = 0;
    for (const [, rec] of this.store) {
      if (rec.expireAt > now) active++;
      else expired++;
    }
    return {
      total: this.store.size,
      active,
      expired,
      maxSize: this.options.maxSize,
      memoryBytes: this.totalMemoryBytes,
      maxMemoryBytes: this.options.maxMemoryBytes,
      memoryUsagePercent:
        Math.round(
          (this.totalMemoryBytes / this.options.maxMemoryBytes) * 10000
        ) / 100,
      hits: this.metrics.hits,
      misses: this.metrics.misses,
      evictions: this.metrics.evictions,
    };
  }

  forceCleanup(): void {
    this.lastCleanup = 0;
    this.maybeCleanup();
  }
}
