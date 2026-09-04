import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { loggers } from "../utils/logger";

/**
 * 频道配置服务（2026-08-24）
 *
 * 频道清单加密（AES-256-GCM）存入 Turso channel_config 表，
 * 本服务启动/定期拉取最新版本并解密缓存，供搜索服务读取。
 *
 * 配置（环境变量）：
 *   TURSO_URL / TURSO_AUTH_TOKEN   Turso 连接（与热搜同库）
 *   CHANNEL_KEY                    64 位 hex（32 字节），加密/解密密钥
 *   CHANNELS_JSON                  （可选兜底）明文 JSON
 *   CHANNELS_KEYS                  （可选）频道配置分级 key1:grant1|key2:all
 *   CHANNELS_REMOTE_URL            （可选）远程频道配置源，缺省用内置默认地址
 *   CHANNELS_API_KEY               （可选）拉取远程配置的鉴权标识
 *
 * 加载顺序：Turso > CHANNELS_JSON > 远程频道配置源 > 空。
 * 加密说明：AES-256-GCM（认证加密）。密钥只存在于服务器环境变量。
 */

export interface ChannelConfig {
  version: number;
  priorityChannels: string[];
  defaultChannels: string[];
  /**
   * 频道备注名（2026-08-26 管理后台"频道名字"列）。
   * key = 频道 ID（TG username，即 priority/default 里的字符串），
   * value = 管理员自定义的显示名/备注。可空（未备注的频道只显示 ID）。
   * 不会参与搜索逻辑，仅管理后台展示与编辑。
   */
  channelNames?: Record<string, string>;
}

export interface ChannelConfigServiceOptions {
  tursoUrl?: string;
  authToken?: string;
  channelKey?: string;
  envJson?: string;
  /** 远程频道配置源（无本地配置时的兜底，见 loadFromRemote） */
  remoteUrl?: string;
  /** 拉取远程配置时的鉴权标识（可选） */
  remoteKey?: string;
  /** 频道配置分级（key → 数量或 "all"；例 key1:15|key2:all），见 resolveChannelGrant */
  channelsKeys?: string;
}

/**
 * 远程频道配置源默认地址（写死，部署方无需任何配置即可获得频道配置兜底）
 */
export const DEFAULT_CHANNELS_REMOTE_URL =
  "https://panhub.shenzjd.com/api/channels";

/**
 * AES-256-GCM 加密（供 sync 脚本侧保持一致的密文格式：iv.tag.data，均 base64）
 */
export function encryptChannelConfig(plain: string, keyHex: string): string {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) {
    throw new Error("CHANNEL_KEY 必须是 64 位 hex（32 字节）");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString("base64"),
    tag.toString("base64"),
    encrypted.toString("base64"),
  ].join(".");
}

/**
 * AES-256-GCM 解密（与 encryptChannelConfig 对称）
 */
export function decryptChannelConfig(payload: string, keyHex: string): string {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) {
    throw new Error("CHANNEL_KEY 必须是 64 位 hex（32 字节）");
  }
  const parts = payload.split(".");
  if (parts.length !== 3) {
    throw new Error("频道配置密文格式非法");
  }
  const [ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivB64, "base64")
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function toChannelConfig(parsed: any): ChannelConfig | null {
  if (!parsed || typeof parsed !== "object") return null;
  const pick = (key: string): string[] =>
    Array.isArray(parsed[key])
      ? parsed[key].filter((x: unknown) => typeof x === "string")
      : [];
  // channelNames：{ id: name } 映射（仅保留对象、key/value 为字符串且 key 非空）
  const names: Record<string, string> = {};
  if (parsed.channelNames && typeof parsed.channelNames === "object") {
    for (const [k, v] of Object.entries(parsed.channelNames)) {
      if (k && typeof v === "string" && v.trim()) names[k] = v.trim();
    }
  }
  return {
    version: Number(parsed.version) || 0,
    priorityChannels: pick("priorityChannels"),
    defaultChannels: pick("defaultChannels"),
    channelNames: Object.keys(names).length ? names : undefined,
  };
}

export class ChannelConfigService {
  private config: ChannelConfig | null = null;
  private loadPromise: Promise<ChannelConfig | null> | null = null;
  private options: ChannelConfigServiceOptions;

  constructor(options: ChannelConfigServiceOptions = {}) {
    // remoteUrl 缺省时使用内置默认地址，部署方零配置即可获得频道配置兜底
    this.options = {
      ...options,
      remoteUrl: options.remoteUrl || DEFAULT_CHANNELS_REMOTE_URL,
    };
  }

  /**
   * 同步快照：优先内存缓存，其次 CHANNELS_JSON 兜底，都没有返回空配置。
   * 用于创建 SearchService 时注入频道（搜索请求前的 ensureLoaded 已保证有值）。
   */
  getSnapshot(): ChannelConfig {
    if (this.config) return { ...this.config };
    const fromEnv = this.parseEnvJson();
    if (fromEnv) return fromEnv;
    return { version: 0, priorityChannels: [], defaultChannels: [], channelNames: undefined };
  }

  /**
   * 确保频道配置已加载（幂等，并发去重）。
   *
   * 2026-08-24 用户拍板：频道清单几乎不变，**首次加载后永久缓存**，
   * 不再按 TTL 定期重拉 Turso（改频道需重启服务/重新部署生效）。
   * 首次加载失败（Turso 临时不可用）会在下次请求重试；成功后就固定。
   * 搜索 API 入口调用；Turso 不可用时静默降级到 env 兜底/空配置。
   */
  async ensureLoaded(): Promise<ChannelConfig> {
    if (this.config) return this.getSnapshot();
    if (!this.loadPromise) {
      this.loadPromise = this.load()
        .catch((err) => {
          loggers.search.error("频道配置加载失败", {
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        })
        .finally(() => {
          this.loadPromise = null;
        });
    }
    await this.loadPromise;
    return this.getSnapshot();
  }

  /**
   * 保存频道配置（2026-08-26 管理后台 CRUD 落库）
   *
   * 全量替换语义：把 priorityChannels / defaultChannels 加密写入 Turso
   * 新版本（version 递增），并更新内存缓存使搜索立即生效。
   *
   * 数据模型说明：priority 频道 = 不下发给第三方（fork 站）的"固定下发
   * 渠道"；default 频道 = 常规下发。同一频道出现在两个数组时，下发侧
   * getGrantedChannels 会将其从 default 剔除，因此"设优先"与"取消优先"
   * 等价于在两组间移动。为减少意外，保存时强制去重（同一频道只允许
   * 出现在 priority 或 default 一侧，若两侧都有则从 default 剔除）。
   *
   * 前置条件：必须配置 TURSO_URL + CHANNEL_KEY（否则无法持久化，
   * 抛出错误由调用方提示"当前未配置数据库，修改不会生效"）。
   */
  async save(next: ChannelConfig): Promise<ChannelConfig> {
    const { tursoUrl, authToken, channelKey } = this.options;
    if (!tursoUrl || !channelKey) {
      throw new Error("频道配置保存在本部署不可用：缺少 TURSO_URL / CHANNEL_KEY");
    }

    // 校验 + 规范化：数组、非空字符串、去重、长度上限
    const norm = (key: "priorityChannels" | "defaultChannels"): string[] => {
      const list = Array.isArray(next[key]) ? next[key] : [];
      const seen = new Set<string>();
      const out: string[] = [];
      for (const item of list) {
        const v = typeof item === "string" ? item.trim() : "";
        if (!v || v.length > 100) continue;
        if (seen.has(v)) continue;
        seen.add(v);
        out.push(v);
      }
      return out;
    };
    let priority = norm("priorityChannels");
    let defaults = norm("defaultChannels");

    // priority 与 default 互斥：同出现在 default 的 priority 自动剔除（与下发语义一致）
    const priSet = new Set(priority);
    defaults = defaults.filter((c) => !priSet.has(c));

    // 频道备注名规范化：仅保留"确实存在的频道 ID"的备注，剔除无用/超长项
    const names: Record<string, string> = {};
    if (next.channelNames && typeof next.channelNames === "object") {
      const known = new Set([...priority, ...defaults]);
      for (const [id, name] of Object.entries(next.channelNames)) {
        const cleanName = typeof name === "string" ? name.trim() : "";
        if (id && known.has(id) && cleanName && cleanName.length <= 100) {
          names[id] = cleanName;
        }
      }
    }
    const hasNames = Object.keys(names).length > 0;

    // 空配置保护：不允许把两份都清空（防止误删全部频道导致服务不可用）
    if (priority.length === 0 && defaults.length === 0) {
      throw new Error("频道清单不能为空：至少保留一个频道");
    }

    const { createClient } = await import("@libsql/client");
    const client = createClient({ url: tursoUrl, authToken: authToken || undefined });
    try {
      const rows = (
        await client.execute("SELECT COALESCE(MAX(version), 0) AS v FROM channel_config")
      ).rows;
      const version = Number(rows[0]?.v) + 1; // 并发安全：DB 端取 MAX 递增
      const plain = JSON.stringify({
        priorityChannels: priority,
        defaultChannels: defaults,
        ...(hasNames ? { channelNames: names } : {}),
      });
      const payload = encryptChannelConfig(plain, channelKey);
      await client.execute(
        "INSERT INTO channel_config (version, payload, updated_at) VALUES (?, ?, ?)",
        [version, payload, Date.now()]
      );
      // 立即生效：更新内存缓存
      this.config = {
        version,
        priorityChannels: priority,
        defaultChannels: defaults,
        ...(hasNames ? { channelNames: names } : {}),
      };
      loggers.search.info("频道配置已保存（管理后台 CRUD）", {
        version,
        priorityCount: priority.length,
        defaultCount: defaults.length,
      });
      return this.getSnapshot();
    } finally {
      try {
        client.close();
      } catch {}
    }
  }

  /**
   * 强制重新加载（清缓存后重新走加载链；用于管理后台"重载配置"）。
   * 与 ensureLoaded 不同：忽略已有缓存，总是重新拉取最新配置并更新 this.config。
   * 加载失败保持旧配置可用（fail-safe），并把错误抛给调用方记录。
   */
  async reload(): Promise<ChannelConfig> {
    if (this.loadPromise) await this.loadPromise; // 等待进行中的加载收敛
    this.config = null;
    try {
      const loaded = await this.load();
      this.config = loaded || null;
      return this.getSnapshot();
    } catch (err) {
      // 加载失败：不破坏已有配置（若已成功过则沿用），错误抛给调用方（管理页提示）
      if (this.loadPromise) this.loadPromise = null;
      throw err;
    }
  }

  /**
   * 频道配置下发（取 defaultChannels 前 N 个；priority 频道即使同时
   * 出现在 default 中也剔除，不随下发暴露）。用于 /api/channels。
   */
  getGrantedChannels(limit: number): { version: number; channels: string[] } {
    const snap = this.getSnapshot();
    const safeLimit = Math.max(0, Math.floor(limit));
    const prioritySet = new Set(snap.priorityChannels);
    const granted = snap.defaultChannels.filter(
      (channel) => !prioritySet.has(channel)
    );
    return {
      version: snap.version,
      channels: granted.slice(0, safeLimit),
    };
  }

  /**
   * 频道配置分级解析。
   * CHANNELS_KEYS 格式：`key1:grant1|key2:grant2`（用 | 分隔、key:grant 配对，
   * 避免特殊字符在 .env 解析时被破坏）。grant 支持数字或 "all"（全部 default 频道）。
   *
   * - 无 key / key 未注册 / 未配置 → defaultLimit
   * - key 对应数值 → 该数；key 对应 "all" → 全部 defaultChannels 数量
   * - 非法值 → 回落 defaultLimit
   */
  resolveChannelGrant(
    apiKey: string | null | undefined,
    defaultLimit: number
  ): number {
    const fallback = Math.max(0, Math.floor(defaultLimit));
    if (!apiKey) return fallback;
    const keysRaw = this.options.channelsKeys;
    if (!keysRaw) return fallback;
    try {
      const grant = this.parseGrantValue(keysRaw, apiKey);
      if (grant == null) return fallback;
      if (String(grant).toLowerCase() === "all") {
        return this.getSnapshot().defaultChannels.length;
      }
      const n = Number(grant);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
    } catch {
      return fallback;
    }
  }

  private parseGrantValue(keysRaw: string, apiKey: string): string | null {
    // 兼容 JSON 格式（历史配置）：{"keyA":"15","keyB":"all"}
    const trimmed = keysRaw.trim();
    if (trimmed.startsWith("{")) {
      try {
        const map = JSON.parse(trimmed);
        const v = map[apiKey];
        return v == null ? null : String(v);
      } catch {
        return null;
      }
    }
    // 推荐格式：key1:grant1|key2:grant2
    for (const pair of trimmed.split("|")) {
      const idx = pair.indexOf(":");
      if (idx <= 0) continue;
      const k = pair.slice(0, idx).trim();
      if (k === apiKey) return pair.slice(idx + 1).trim() || null;
    }
    return null;
  }

  private async load(): Promise<ChannelConfig | null> {
    // 1. Turso 加密配置（生产主路径）
    const fromTurso = await this.loadFromTurso();
    if (fromTurso) {
      this.config = fromTurso;
            loggers.search.info("频道配置已从 Turso 加载", { version: fromTurso.version });
      return fromTurso;
    }
    // 2. CHANNELS_JSON 兜底（本地 dev / 服务器 .env）
    const fromEnv = this.parseEnvJson();
    if (fromEnv) {
      this.config = fromEnv;
            loggers.search.warn("频道配置来自 CHANNELS_JSON 兜底", { version: fromEnv.version });
      return fromEnv;
    }
    // 3. 远程频道源兜底
    const fromRemote = await this.loadFromRemote();
    if (fromRemote) {
      this.config = fromRemote;
            loggers.search.warn("频道配置来自远程频道源", {
        version: fromRemote.version,
        channelCount: fromRemote.defaultChannels.length,
      });
      return fromRemote;
    }
    loggers.search.warn("频道配置未加载：本地与远程频道源均不可用");
    return null;
  }

  /**
   * 远程频道配置兜底层：从 remoteUrl 拉取频道配置。
   * 响应格式与 /api/channels 一致：{ code: 0, data: { version, channels } }。
   * 失败静默（不影响主链路），8s 超时。
   */
  private async loadFromRemote(): Promise<ChannelConfig | null> {
    const url = this.options.remoteUrl;
    if (!url) return null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const resp = await fetch(url, {
          headers: this.options.remoteKey
            ? { authorization: `Bearer ${this.options.remoteKey}` }
            : undefined,
          signal: controller.signal,
        });
        if (!resp.ok) return null;
        const body: any = await resp.json();
        const channels = Array.isArray(body?.data?.channels)
          ? body.data.channels.filter((x: unknown) => typeof x === "string")
          : [];
        if (channels.length === 0) return null;
        return {
          version: Number(body?.data?.version) || 0,
          priorityChannels: [],
          defaultChannels: channels,
          channelNames: undefined,
        };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      loggers.search.warn("远程频道源拉取失败（走空配置）", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private async loadFromTurso(): Promise<ChannelConfig | null> {
    const { tursoUrl, authToken, channelKey } = this.options;
    if (!tursoUrl || !channelKey) return null;
    const { createClient } = await import("@libsql/client");
    const client = createClient({ url: tursoUrl, authToken: authToken || undefined });
    try {
      const rows = (
        await client.execute(
          "SELECT version, payload FROM channel_config ORDER BY version DESC LIMIT 1"
        )
      ).rows;
      const row = rows[0];
      if (!row || typeof row.payload !== "string") return null;
      const plain = decryptChannelConfig(row.payload, channelKey);
      const parsed = JSON.parse(plain);
      const config = toChannelConfig(parsed);
      if (!config) return null;
      // version 以表列为准（payload 内若带 version 仅作后备，避免两份数据不一致）
      return { ...config, version: Number(row.version) || config.version };
    } catch (err) {
      loggers.search.warn("Turso 频道配置拉取失败（走兜底）", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      try {
        client.close();
      } catch {}
    }
  }

  private parseEnvJson(): ChannelConfig | null {
    if (!this.options.envJson) return null;
    try {
      return toChannelConfig(JSON.parse(this.options.envJson));
    } catch {
      return null;
    }
  }
}

// 全局单例（构造时从环境变量读取配置；测试请直接 new 注入 file: 库与密钥）
const globalChannelConfigService = new ChannelConfigService({
  tursoUrl: process.env.TURSO_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
  channelKey: process.env.CHANNEL_KEY,
  envJson: process.env.CHANNELS_JSON,
  remoteUrl: process.env.CHANNELS_REMOTE_URL,
  remoteKey: process.env.CHANNELS_API_KEY,
  channelsKeys: process.env.CHANNELS_KEYS,
});
export function getChannelConfigService(): ChannelConfigService {
  return globalChannelConfigService;
}
