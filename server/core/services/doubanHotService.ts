/**
 * 豆瓣影视榜单服务
 * 使用豆瓣 JSON API (/j/chart/top_list) 获取数据，替代 HTML 爬虫
 *
 * 优点：返回结构化 JSON，无需 cheerio 解析，自带封面 URL，更稳定
 */

import { ofetch } from "ofetch";
import { load } from "cheerio";
import { createClient, type Client } from "@libsql/client";
import { DOUBAN_HOT_SOURCES, type DoubanHotSourceConfig } from "../../../config/doubanHot";
import { MemoryCache } from "../cache/memoryCache";

export interface DoubanHotItem {
  id?: number;
  title: string;
  url?: string;
  cover?: string;
  desc?: string;
  hot?: number;
}

export interface DoubanHotPageResult {
  items: DoubanHotItem[];
  hasMore: boolean;
}

/** 豆瓣 top_list API 返回的原始结构 */
interface DoubanApiItem {
  id: string;
  title: string;
  score: string;
  rating: string[];
  cover_url: string;
  url: string;
  types: string[];
  regions: string[];
  actors: string[];
  release_date: string;
  vote_count: number;
  rank: number;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时（榜单一天更新一次即可）
const API_BASE = "https://movie.douban.com/j/chart/top_list";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const PAGE_SIZE = 20;

const allItemsCache = new MemoryCache<DoubanHotItem[]>({ maxSize: 30 });

/**
 * 豆瓣缓存持久化到 Turso（2026-08-18）：
 * CF Worker 冷启动会丢内存缓存，导致每次冷启动都重新爬豆瓣（最慢 20s+）。
 * 用 Turso 存 JSON（跨部署共享、冷启动不丢、24h 过期自动刷新）。
 * 未配置 TURSO_URL 时自动回退纯内存缓存（不崩）。
 */
let tursoClient: Client | null = null;
let tursoCacheReady: Promise<void> | null = null;

function getTursoCacheClient(): Client | null {
  if (!process.env.TURSO_URL) return null;
  if (!tursoClient) {
    try {
      tursoClient = createClient({
        url: process.env.TURSO_URL,
        authToken: process.env.TURSO_AUTH_TOKEN || undefined,
      });
    } catch {
      return null;
    }
  }
  return tursoClient;
}

/** 初始化缓存表（幂等，懒执行一次） */
function ensureTursoCacheTable(): Promise<void> {
  if (!tursoCacheReady) {
    tursoCacheReady = (async () => {
      const c = getTursoCacheClient();
      if (!c) return;
      try {
        await c.execute(
          `CREATE TABLE IF NOT EXISTS douban_cache (
            cache_key TEXT PRIMARY KEY,
            data_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
          )`
        );
      } catch {}
    })();
  }
  return tursoCacheReady;
}

/** 从 Turso 读缓存（未命中/过期返回 null） */
async function getPersistedCache(key: string): Promise<DoubanHotItem[] | null> {
  const c = getTursoCacheClient();
  if (!c) return null;
  try {
    await ensureTursoCacheTable();
    const row = (await c.execute(
      "SELECT data_json, updated_at FROM douban_cache WHERE cache_key = ?",
      [key]
    )).rows[0];
    if (!row) return null;
    if (Date.now() - Number(row.updated_at) > CACHE_TTL_MS) return null;
    return JSON.parse(row.data_json as string) as DoubanHotItem[];
  } catch {
    return null;
  }
}

/** 写 Turso 缓存（失败静默，不影响主流程） */
async function setPersistedCache(key: string, items: DoubanHotItem[]): Promise<void> {
  const c = getTursoCacheClient();
  if (!c) return;
  try {
    await ensureTursoCacheTable();
    await c.execute(
      "INSERT OR REPLACE INTO douban_cache (cache_key, data_json, updated_at) VALUES (?, ?, ?)",
      [key, JSON.stringify(items), Date.now()]
    );
  } catch {}
}

/** 将豆瓣 API 返回的 item 转为 DoubanHotItem */
function mapItem(raw: DoubanApiItem, index: number): DoubanHotItem {
  const score = raw.score || raw.rating?.[0] || "";
  const title = score ? `【${score}】${raw.title}` : raw.title;
  const desc = [raw.types?.join("/"), raw.regions?.join("/")]
    .filter(Boolean)
    .join(" · ");

  return {
    id: Number(raw.id) || undefined,
    title,
    cover: raw.cover_url || undefined,
    desc,
    url: raw.url || `https://movie.douban.com/subject/${raw.id}/`,
  };
}

/**
 * 从豆瓣 JSON API 获取指定类型的榜单
 * @param typeId 豆瓣分类 ID（0=Top250, 3=剧情, 5=动作, ...）
 * @param limit 获取数量
 */
async function fetchTopList(typeId: number, limit = 50): Promise<DoubanHotItem[]> {
  const allItems: DoubanHotItem[] = [];
  const batchSize = Math.min(limit, PAGE_SIZE);

  for (let start = 0; start < limit; start += batchSize) {
    const url = `${API_BASE}?type=${typeId}&interval_id=100:90&action=&start=${start}&limit=${batchSize}`;

    try {
      const data = await ofetch<DoubanApiItem[]>(url, {
        headers: { "user-agent": UA },
        timeout: 10000,
      });

      if (!Array.isArray(data) || data.length === 0) break;

      for (let i = 0; i < data.length; i++) {
        allItems.push(mapItem(data[i], start + i));
      }

      // 如果返回的数据少于请求数，说明没有更多了
      if (data.length < batchSize) break;
    } catch (e: any) {
      console.warn(`[DoubanAPI] type=${typeId} start=${start} 失败:`, e?.message);
      break;
    }
  }

  return allItems;
}

/**
 * Top250 专用爬虫（该分类不支持 JSON API，需爬 HTML）
 * 注意：CF Worker 冷启动后内存缓存丢失，爬虫耗时直接影响首屏。
 * 页数/sleep 需克制：4 页（100 条）够翻页展示，间隔 500ms 防封且快。
 */
async function scrapeTop250(): Promise<DoubanHotItem[]> {
  const allItems: DoubanHotItem[] = [];
  const UA_LOCAL = "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15";
  const PAGE_COUNT = 4;
  const PAGE_SLEEP_MS = 500;

  for (let page = 0; page < PAGE_COUNT; page++) {
    const start = page * 25;
    const url = start === 0
      ? "https://movie.douban.com/top250"
      : `https://movie.douban.com/top250?start=${start}`;

    try {
      const html = await ofetch<string>(url, {
        headers: { "user-agent": UA_LOCAL },
        timeout: 5000,
      });
      const $ = load(html);

      $(".article ol.grid_view li").each((_, el) => {
        const dom = $(el);
        const href = dom.find(".pic a").attr("href") || "";
        const id = Number(href.match(/\d+/)?.[0]) || undefined;
        const rawTitle = dom.find(".info .title").first().text() || "";
        const score = dom.find(".info .rating_num").text().trim() || "0.0";
        const title = rawTitle ? `【${score}】${rawTitle}` : "";
        if (!title) return;

        const img = dom.find("img");
        const cover = img.attr("data-src") || img.attr("src") || undefined;
        const coverUrl = cover?.startsWith("//") ? "https:" + cover : cover;

        allItems.push({
          id,
          title,
          cover: coverUrl,
          desc: dom.find(".info .inq").text().trim(),
          url: href || `https://movie.douban.com/subject/${id}/`,
        });
      });

      if (page < PAGE_COUNT - 1) await new Promise((r) => setTimeout(r, PAGE_SLEEP_MS));
    } catch {
      if (page >= 1 && allItems.length === 0) break;
    }
  }

  return allItems;
}

/** 获取指定分类的全部数据（带缓存：内存 → Turso → 豆瓣） */
async function fetchAllItems(categoryId: string): Promise<DoubanHotItem[]> {
  const cacheKey = `douban-api:${categoryId}`;

  // 1. 内存缓存（热启动秒回）
  const cached = allItemsCache.get(cacheKey);
  if (cached.hit && cached.value) return cached.value;

  // 2. Turso 持久化缓存（冷启动不丢，跨部署共享）
  const persisted = await getPersistedCache(cacheKey);
  if (persisted) {
    allItemsCache.set(cacheKey, persisted, CACHE_TTL_MS);
    return persisted;
  }

  const config = DOUBAN_HOT_SOURCES.find((s) => s.id === categoryId);
  if (!config) return [];

  // 3. 拉取豆瓣（Top250 不支持 JSON API，用独立爬虫）
  const items = config.typeId === -1
    ? await scrapeTop250()
    : await fetchTopList(config.typeId);
  if (items.length > 0) {
    allItemsCache.set(cacheKey, items, CACHE_TTL_MS);
    // await 写入 Turso：Worker 响应后 isolate 会被回收，fire-and-forget 会导致写入丢失
    await setPersistedCache(cacheKey, items);
  }
  return items;
}

export function extractSearchTerm(title: string): string {
  return title.replace(/^【[\d.]+】/, "").trim() || title;
}

/** 分页获取指定分类的数据 */
export async function fetchDoubanHotByCategory(
  category: string,
  page: number = 1,
  limit: number = PAGE_SIZE
): Promise<DoubanHotPageResult> {
  const allItems = await fetchAllItems(category);
  const start = (page - 1) * limit;
  const end = start + limit;

  return {
    items: allItems.slice(start, end),
    hasMore: end < allItems.length,
  };
}

/** 获取所有分类的数据 */
export async function fetchDoubanHot(
  categories?: string[]
): Promise<{ categories: Record<string, { id: string; label: string; title: string; type: string; items: DoubanHotItem[] }> }> {
  const ids = categories?.length
    ? categories
    : DOUBAN_HOT_SOURCES.map((s) => s.id);

  const results: Record<string, { id: string; label: string; title: string; type: string; items: DoubanHotItem[] }> = {};

  await Promise.all(
    ids.map(async (id) => {
      const config = DOUBAN_HOT_SOURCES.find((s) => s.id === id);
      if (!config) return;

      try {
        const items = await fetchAllItems(id);
        results[id] = {
          id: config.id,
          label: config.label,
          title: config.label,
          type: config.type,
          items,
        };
      } catch (e: any) {
        results[id] = {
          id: config.id,
          label: config.label,
          title: config.label,
          type: config.type,
          items: [],
        };
        console.warn(`[DoubanAPI] ${id} 失败:`, e?.message);
      }
    })
  );

  return { categories: results };
}
