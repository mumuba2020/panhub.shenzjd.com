/**
 * 热搜索存储接口
 * 定义统一的存储操作，支持多种实现方式
 */
export interface IHotSearchStore {
  /**
   * 记录搜索词（增加分数）
   * @param term  搜索词
   * @param now   搜索时间戳（epoch ms）
   * @param delta 热度/计数增量，默认 1；批量聚合场景传入窗口内累计次数，
   *              一次写入合并 N 次搜索（score 衰减后 +delta、count +delta）
   */
  recordSearch(term: string, now: number, delta?: number): Promise<void>;

  /**
   * 批量落盘一批词增量（flush 用，2026-09-01 新增）
   * 实现方应合并为单次 batch 往返（libsql client.batch），替代逐词 execute。
   * @param entries 已按词聚合的增量列表（term 已规范化）
   * @returns 本批新增词数（2026-09-03 新增：供 flush 维护 total_terms 计数器）
   */
  recordSearchBatch(entries: { term: string; lastAt: number; delta: number }[]): Promise<number>;

  /**
   * 批量累加多天的搜索次数（flush 用，2026-09-01 新增）
   * 实现方应合并为单次 batch 往返。
   */
  recordDailySearchesBatch(entries: { date: string; delta: number }[]): Promise<void>;

  /**
   * 累加词库总词数计数器（flush 检测到新词时调用，2026-09-03 新增）。
   * 实现方维护 stats_meta 类计数器，供 getCalendarMeta 免全表 COUNT(*) 读取。
   */
  incrementTotalTerms(n: number): Promise<void>;

  /**
   * 获取热搜列表
   */
  getHotSearches(limit: number): Promise<HotSearchItem[]>;

  /**
   * 获取今日热搜词池的随机样本（首页词云用）
   * 数据源为全量词库 search_terms，按北京时间今日 0 点过滤，随机取 limit 条。
   * 理由：网盘搜索为超长尾需求，同词搜索人数极少，热度排名无统计意义，
   * 随机展示今日真实被搜过的词，保证每次刷新都有新鲜感。
   */
  getRandomHotSearches(limit: number): Promise<HotSearchItem[]>;

  /**
   * 清理超出限制的旧记录
   */
  cleanupOldEntries(maxEntries: number): Promise<void>;

  /**
   * 清除所有热搜记录
   */
  clearHotSearches(): Promise<{ success: boolean; message: string }>;

  /**
   * 删除指定热搜词
   */
  deleteHotSearch(term: string): Promise<{ success: boolean; message: string }>;

  /**
   * 获取热搜统计信息
   */
  getStats(): Promise<HotSearchStats>;

  /**
   * 获取每日榜单日历（近 N 天，每天词数与 top3；次数由 getDailySearchesRange 单独提供）
   * 实时聚合 search_terms，日期按北京时间
   */
  getCalendar(days: number): Promise<DaySnapshot[]>;

  /**
   * 获取历史累计搜索总次数（全表 SUM(count)）
   * count 为每个词的累计搜索次数，全表求和即从建库以来所有搜索次数的总和。
   */
  getTotalSearches(): Promise<number>;

  /**
   * 获取词库累计词数（全表 COUNT(*)）
   */
  getTotalTerms(): Promise<number>;

  /**
   * 累加指定日期（北京时间 YYYY-MM-DD）的搜索次数（daily_searches 表，精确增量）
   * 从部署起每次搜索 +delta，是"今日搜索次数"的可靠数据源（无历史回填，避免虚高）。
   * @param date  北京时间日期键
   * @param delta 该日期新增搜索次数（flush 聚合后的真实次数）
   */
  recordDailySearches(date: string, delta: number): Promise<void>;

  /**
   * 读取指定日期的搜索次数（daily_searches）；无记录返回 0
   */
  getDailySearches(date: string): Promise<number>;

  /**
   * 一次 batch 查日历页头三件套：totalTerms（总词数 COUNT(*)）、
   * totalSearches（总次数 SUM(count)）、dailyDayCount（有次数记录的天数）
   * （2026-08-30 扩展：原 totalTerms + dailyDayCount 两查合并 batch 的基础上，
   * 再并入总搜索次数，hot-stats 一次往返拿全统计带指标）
   */
  getCalendarMeta(): Promise<{
    totalTerms: number;
    totalSearches: number;
    dailyDayCount: number;
  }>;

  /**
   * 搜索次数是否已积累足够（记录天数 >= minDays 才可展示，用户拍板：攒一星期再展示）
   * 返回 daily_searches 中有记录的天数
   */
  getDailySearchesDayCount(): Promise<number>;

  /**
   * 获取指定日期的全量词单
   */
  getDayItems(date: string): Promise<DayTerm[]>;

  /**
   * 获取高价值搜索词（按搜索次数降序，用于 SEO sitemap 选词）
   */
  getTopTerms(limit: number): Promise<TopTerm[]>;

  /**
   * 关闭存储连接
   */
  close(): void;
}

export interface HotSearchItem {
  term: string;
  score: number;
  lastSearched: number;
  createdAt: number;
  rank?: number;
  displayScore?: number;
}

export interface HotSearchStats {
  total: number;
  topTerms: HotSearchItem[];
}

export interface TopTerm {
  term: string;
  count: number;
}

export interface DaySnapshot {
  /** 日期键 YYYY-MM-DD */
  date: string;
  /** 当天搜索词数（search_terms 按 last_at 分组计数，历史全有） */
  count: number;
  /**
   * 当天真实搜索次数（daily_searches 精确记录，2026-08-22 起有值）。
   * null = 当天无次数记录（早于记录起始日），展示层不得拿词数冒充次数。
   */
  searches: number | null;
  /** 当天热度最高的 3 个词 */
  top: string[];
}

export interface DayTerm {
  term: string;
  /** 当天排名（按搜索次数降序） */
  rank: number;
  /** 当天搜索次数 */
  count: number;
}
