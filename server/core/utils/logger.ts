/**
 * 结构化日志系统
 * 支持不同级别的日志输出，便于调试和监控
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_COLORS = {
  debug: "\x1b[36m", // cyan
  info: "\x1b[32m",  // green
  warn: "\x1b[33m",  // yellow
  error: "\x1b[31m", // red
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bright: "\x1b[1m",
};

export interface LogOptions {
  level?: LogLevel;
  service?: string;
  enableColors?: boolean;
}

export interface LogMeta {
  [key: string]: any;
}

export class Logger {
  private level: LogLevel;
  private service: string;
  private enableColors: boolean;
  private levelPriority: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  constructor(options: LogOptions = {}) {
    const rawLevel = options.level || process.env.LOG_LEVEL || "info";
    const validLevels: string[] = ["debug", "info", "warn", "error"];
    this.level = (validLevels.includes(rawLevel) ? rawLevel : "info") as LogLevel;
    this.service = options.service || "panhub";
    this.enableColors = options.enableColors ?? process.env.NODE_ENV !== "production";
  }

  private shouldLog(level: LogLevel): boolean {
    return this.levelPriority[level] >= this.levelPriority[this.level];
  }

  private colorize(text: string, type: LogLevel | "dim" | "bright" | "reset" = "reset"): string {
    if (!this.enableColors) return text;
    const color = LOG_LEVEL_COLORS[type] || LOG_LEVEL_COLORS.reset;
    return `${color}${text}${LOG_LEVEL_COLORS.reset}`;
  }

  /**
   * 北京时间（UTC+8）格式化，输出保留时区偏移的 ISO 风格时间：
   * 例：2026-08-14T11:43:09.762+08:00
   * 服务器可能运行在 UTC 环境（Docker/CF Workers），显式 +8，不依赖宿主时区
   */
  private formatBeijingTime(d: Date): string {
    const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
    const t = new Date(d.getTime() + BEIJING_OFFSET_MS);
    const pad = (n: number) => String(n).padStart(2, "0");
    return (
      `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}` +
      `T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}` +
      `.${String(t.getUTCMilliseconds()).padStart(3, "0")}+08:00`
    );
  }

  private formatMessage(level: LogLevel, message: string, meta?: LogMeta): string {
    const timestamp = this.formatBeijingTime(new Date());

    const parts: string[] = [];

    // 时间戳
    parts.push(this.colorize(`[${timestamp}]`, "dim"));

    // 级别
    parts.push(this.colorize(`[${level.toUpperCase()}]`, level));

    // 服务名
    parts.push(this.colorize(`[${this.service}]`, "bright"));

    // 消息
    parts.push(message);

    // 元数据（单行紧凑格式：一行一条日志，便于 grep 与日志采集）
    if (meta && Object.keys(meta).length > 0) {
      parts.push(this.colorize(JSON.stringify(meta), "dim"));
    }

    return parts.join(" ");
  }

  debug(message: string, meta?: LogMeta): void {
    if (!this.shouldLog("debug")) return;
    console.debug(this.formatMessage("debug", message, meta));
  }

  info(message: string, meta?: LogMeta): void {
    if (!this.shouldLog("info")) return;
    console.info(this.formatMessage("info", message, meta));
  }

  warn(message: string, meta?: LogMeta): void {
    if (!this.shouldLog("warn")) return;
    console.warn(this.formatMessage("warn", message, meta));
  }

  error(message: string, error?: Error | LogMeta): void {
    if (!this.shouldLog("error")) return;
    const meta =
      error instanceof Error
        ? { message: error.message, stack: error.stack, name: error.name }
        : error;
    console.error(this.formatMessage("error", message, meta as LogMeta));
  }

  /**
   * 性能计时开始
   */
  startTimer(label: string): () => void {
    const start = Date.now();
    return () => {
      const elapsed = Date.now() - start;
      this.debug(`${label} 完成`, { elapsedMs: elapsed });
    };
  }

  /**
   * 异步性能计时
   */
  async time<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const endTimer = this.startTimer(label);
    try {
      const result = await fn();
      endTimer();
      return result;
    } catch (error) {
      this.error(`${label} 失败`, error as Error);
      throw error;
    }
  }

  // 创建子 logger
  child(service: string): Logger {
    return new Logger({
      level: this.level,
      service: `${this.service}:${service}`,
      enableColors: this.enableColors,
    });
  }
}

// 默认导出实例
export const logger = new Logger({ service: "main" });

// 工厂函数
export function createLogger(service: string): Logger {
  return new Logger({ service });
}

// 模块专用日志器
export const loggers = {
  search: createLogger("Search"),
  cache: createLogger("Cache"),
  plugin: createLogger("Plugin"),
  tg: createLogger("TG"),
  api: createLogger("API"),
  hotSearch: createLogger("HotSearch"),
  health: createLogger("Health"),
};
