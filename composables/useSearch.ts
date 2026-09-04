import type { MergedLinks, GenericResponse, SearchResponse } from "~/types/search";
import type { UnlockTicket } from "~/composables/useUnlockAd";
import { extractMergedFromResponse } from "~/utils/extractMergedFromResponse";
import { mergeMergedByType } from "~/utils/mergeMergedByType";

const devLog = (...args: any[]) => {
  if (import.meta.dev) console.log(...args);
};
const devWarn = (...args: any[]) => {
  if (import.meta.dev) console.warn(...args);
};
const devError = (...args: any[]) => {
  if (import.meta.dev) console.error(...args);
};

/**
 * 每轮搜索（首搜或每次"继续"）的累计结果上限：
 * 达到后自动暂停，不再发起剩余请求，用户点击"继续"再搜下一轮（阈值累进 +90）。
 * 大部分用户只看前几条，几百条结果纯浪费服务器资源（尤其 TG 真爬请求）。
 */
const MAX_RESULTS_PER_ROUND = 90;

export interface SearchOptions {
  apiBase: string;
  keyword: string;
  settings: {
    concurrency: number;
    pluginTimeoutMs: number;
  };
  /** 当搜索接口返回 401 时回调（公众号认证失效） */
  onAuthRequired?: () => void;
  /**
   * 当搜索接口返回 402 时回调（2026-09-04 页面端免费配额用完）：
   * 弹 floating-unlock 广告弹窗，看完激励视频广告后返回 {ticket, grant}
   * 供自动重试（服务端验票核销后清零配额放行）；返回 null = 用户取消/失败
   */
  onQuotaExceeded?: () => Promise<UnlockTicket | null>;
}

/**
 * 后端 TG 频道分批大小（2026-08-24 频道零落地改造后固定，
 * 必须与 server/core/utils/batchChannels.ts 的默认一致）
 */
const TG_BATCH_SIZE = 2;

/**
 * 是否启用 SSE 流式搜索（2026-08-24 架构改造）：
 * - true：1 个 /api/search.stream 长连接承载整个搜索，服务端逐批推送增量
 *   → wx-auth 只验 1 次，不反复弹验证码
 * - false：回退旧的"countOnly + 多 batch 并发"模式
 * 运行时可被 URL 参数 ?stream=0 强制关闭（灰度/故障逃生）
 */
const USE_STREAM_SEARCH = true;

/** 解析一行 SSE 原始事件块（event:xxx\ndata:yyy） */
interface ParsedSSEEvent {
  event: string;
  data: string;
}
function parseSSEEventBlock(raw: string): ParsedSSEEvent | null {
  const lines = raw.split("\n");
  let event = "message";
  let data = "";
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return null;
  return { event, data };
}

export interface SearchState {
  loading: boolean;
  deepLoading: boolean;
  paused: boolean;
  error: string;
  searched: boolean;
  elapsedMs: number;
  total: number;
  merged: MergedLinks;
}

export function useSearch() {
  const state = ref<SearchState>({
    loading: false,
    deepLoading: false,
    paused: false,
    error: "",
    searched: false,
    elapsedMs: 0,
    total: 0,
    merged: {},
  });

  const setLoading = (v: boolean) => {
    state.value.loading = v;
  };
  const setDeepLoading = (v: boolean) => {
    state.value.deepLoading = v;
  };
  const setPaused = (v: boolean) => {
    state.value.paused = v;
  };
  const setError = (v: string) => {
    state.value.error = v;
  };
  const setSearched = (v: boolean) => {
    state.value.searched = v;
  };
  const setElapsedMs = (v: number) => {
    state.value.elapsedMs = v;
  };
  const setTotal = (v: number) => {
    state.value.total = v;
  };
  const setMerged = (v: MergedLinks) => {
    state.value.merged = v;
  };

  let searchSeq = 0;
  const activeControllers: AbortController[] = [];
  /** 暂停时已完成的任务数，供 continueSearch 从断点续跑 */
  let pausedAtTaskIndex = 0;
  /** 当前并搜已完成数，暂停时用于记录断点 */
  let parallelCompletedCount = 0;
  /** 是否因达到结果上限而自动暂停（区别于用户手动暂停，UI 文案用） */
  const autoPausedAtLimit = ref(false);

  // 取消所有进行中的请求
  function cancelActiveRequests(): void {
    for (const controller of activeControllers) {
      try {
        controller.abort();
      } catch {}
    }
    activeControllers.length = 0;
  }

  // 暂停搜索
  function pauseSearch(): void {
    if (state.value.loading || state.value.deepLoading) {
      autoPausedAtLimit.value = false;
      setPaused(true);
      pausedAtTaskIndex = parallelCompletedCount;
      cancelActiveRequests();
    }
  }

  // 续跑时复用上次 countOnly 拿到的批数（同一关键词的搜索）
  let lastTotalTgBatches = 0;
  let lastCountedKeyword = "";

  /**
   * 断点续跑进度（2026-08-25 用户拍板）：已完成的 SSE 任务全局索引集合。
   * - done 事件回传 completedIndices，这里累积
   * - 「继续」时回传 skipTasks 给后端，后端只跑未搜过的任务
   * - 重新搜索（performSearch / resetSearch）时清空
   */
  let completedTaskGidx = new Set<number>();

  /** 向后端问"有 N 批"，不实际搜索（响应只有数字，无频道明文） */
  async function fetchTgBatchCount(apiBase: string, keyword: string): Promise<number> {
    try {
      const q = new URLSearchParams({
        kw: keyword,
        countOnly: "1",
        batchSize: String(TG_BATCH_SIZE),
        src: "tg",
      });
      const resp = await $fetch<GenericResponse<{ totalBatches: number }>>(
        `${apiBase}/search?${q.toString()}`,
        { credentials: "include" } as any
      );
      return Number(resp.data?.totalBatches) || 0;
    } catch (e) {
      devWarn("fetchTgBatchCount 失败，TG 批数设为 0:", e);
      return 0;
    }
  }

  // 继续搜索（从暂停处继续，与 performParallelSearch 同一套任务流）
  async function continueSearch(options: SearchOptions): Promise<void> {
    if (!state.value.paused || !state.value.searched) return;

    setPaused(false);
    setDeepLoading(true);

    // 目标总数 = 上次已收数量 + 本轮增量（2026-08-25 修复：此前误传"每轮
    // 累进倍数"，手动暂停时已收<90 会导致后端按错误上限多搜；
    // 后端协议就是「目标总数 = 已收 + 90」，必须基于上次实际数量）
    const targetMax = state.value.total + MAX_RESULTS_PER_ROUND;
    autoPausedAtLimit.value = false;

    try {
      if (USE_STREAM_SEARCH && !isStreamDisabledByQuery()) {
        // 流式：重新连 SSE（服务端已有缓存，已搜频道秒回；前端保留已有 merged 继续累加）。
        // 传目标总数 = 已收 + 90，后端自己计数到该值停止
        const { usedFallback } = await performStreamSearch(
          options,
          searchSeq,
          state.value.merged,
          state.value.total,
          targetMax
        );
        if (usedFallback) {
          // fallback：旧批次模式续跑。SSE 全程从未 countOnly，批数必为 0，
          // 需先补一次 countOnly 拿到总批数，否则旧模式无任务可跑
          if (lastCountedKeyword !== keyword) {
            lastTotalTgBatches = await fetchTgBatchCount(options.apiBase, keyword);
            lastCountedKeyword = keyword;
          }
          const startFrom = pausedAtTaskIndex;
          await performParallelSearch(
            options,
            searchSeq,
            startFrom,
            state.value.merged,
            lastTotalTgBatches,
            targetMax
          );
        }
      } else {
        const startFrom = pausedAtTaskIndex;
        await performParallelSearch(
          options,
          searchSeq,
          startFrom,
          state.value.merged,
          lastTotalTgBatches,
          targetMax
        );
      }
    } catch (error) {
      // 忽略错误
    } finally {
      pausedAtTaskIndex = 0;
      setDeepLoading(false);
      // 自动暂停（达上限）时保持 loading，让"继续"按钮仍可用
      if (!state.value.paused) {
        setLoading(false);
      }
    }
  }
  /** 创建带 AbortController 的搜索任务（插件或 TG 批次） */
  function createSearchTask(
    apiBase: string,
    keyword: string,
    conc: number,
    pluginTimeoutMs: number,
    params: {
      src: "plugin" | "tg";
      plugins?: string;
      /** TG 批次：传 batch 索引 + batchSize，后端从频道清单切片（前端无频道知识） */
      batch?: number;
      batchSize?: number;
    },
    label: string,
    shouldSkip: () => boolean,
    onAuthRequired?: () => void,
    /** 是否允许 TG 深搜（翻更多页补结果）。前端拆批后只有最后一批允许，防误触发爆炸 */
    deep = true
  ): () => Promise<MergedLinks> {
    return async () => {
      if (shouldSkip()) return {};
      const ac = new AbortController();
      activeControllers.push(ac);
      try {
        const extParam = JSON.stringify({
          __plugin_timeout_ms: pluginTimeoutMs,
          __deep_search: deep,
        });
        const q = new URLSearchParams({
          kw: keyword,
          res: "merged_by_type",
          src: params.src,
          conc: String(conc),
          ext: extParam,
        });
        if (params.plugins) q.set("plugins", params.plugins);
        if (params.batch != null) {
          q.set("batch", String(params.batch));
          q.set("batchSize", String(params.batchSize || TG_BATCH_SIZE));
        }
        const response = await $fetch<GenericResponse<SearchResponse>>(
          `${apiBase}/search?${q.toString()}`,
          { signal: ac.signal, credentials: "include" } as any
        );
        return extractMergedFromResponse(response.data);
      } catch (error: any) {
        // 主动取消（AbortController.abort）不算失败：
        // ofetch 抛 FetchError 且把 AbortError 包在 cause 链里，需逐层判断
        const isAbort =
          error?.name === "AbortError" ||
          error?.cause?.name === "AbortError" ||
          error?.cause?.cause?.name === "AbortError";
        if (isAbort) return {};
        if (error?.statusCode === 401) onAuthRequired?.();
        devWarn(`${label} search failed:`, error);
        return {};
      } finally {
        const idx = activeControllers.indexOf(ac);
        if (idx >= 0) activeControllers.splice(idx, 1);
      }
    };
  }

  // 并发搜索 - 每个源独立请求，支持从 startFromTaskIndex 断点续跑
  // initialMerged: continueSearch 时传入暂停前已累积的结果，避免覆盖
  // totalTgBatches: 由 performSearch 先 countOnly 拿到（前端无频道知识，后端切片）
  // targetMax: 本轮累计结果上限（首搜默认 90；「继续」传 已收+90），达到自动暂停
  async function performParallelSearch(
    options: SearchOptions,
    mySeq: number,
    startFromTaskIndex = 0,
    initialMerged?: MergedLinks,
    totalTgBatches = 0,
    targetMax = MAX_RESULTS_PER_ROUND
  ): Promise<void> {
    const { apiBase, keyword, settings } = options;
    const conc = Math.min(16, Math.max(1, Number(settings.concurrency || 3)));

    // 2026-08-24：前端不再持有频道清单，TG 批数完全由后端通过 countOnly 告知
    // 2026-08-25：前端不再持有插件知识（插件在后端注册表，全部启用）。
    // 本 fallback（SSE 不可用时）简化为纯 TG 批次搜索 —— 插件结果由 SSE
    // 主通道负责；逃生通道只保底频道搜索，前端零插件知识。
    if (totalTgBatches === 0) {
      setError("请先在设置中选择至少一个搜索来源");
      return;
    }

    // 收集所有搜索任务
    const searchTasks: Array<() => Promise<MergedLinks>> = [];

    const shouldSkip = () => mySeq !== searchSeq || state.value.paused;
    const onAuth = options.onAuthRequired;

    // 为 TG 批次创建搜索任务（每批 batchSize 个频道作为一个任务）：
    // 2026-08-24 频道零落地：前端只传批次号 batch=N，后端从 defaultChannels 切片抓取
    // 服务端单请求只等这一批（2 频道）抓完就返回 → "边搜边出"更细粒度
    for (let i = 0; i < totalTgBatches; i++) {
      const isLastBatch = i === totalTgBatches - 1;
      searchTasks.push(
        createSearchTask(
          apiBase,
          keyword,
          conc,
          settings.pluginTimeoutMs,
          { src: "tg", batch: i, batchSize: TG_BATCH_SIZE },
          `TG batch ${i}`,
          shouldSkip,
          onAuth,
          // 深搜只允许最后一批触发，避免每批"结果<3"误触发翻页爆炸
          isLastBatch
        )
      );
    }

    // 使用 p-limit 控制并发数
    const pLimit = (await import('p-limit')).default;
    const limit = pLimit(conc);

    // 并发执行所有任务，哪个先返回就立即合并展示，不等待其它
    let currentMerged: MergedLinks = initialMerged ? { ...initialMerged } : {};

    const tasksToSchedule =
      startFromTaskIndex > 0 ? searchTasks.slice(startFromTaskIndex) : searchTasks;
    const limitedTasks = tasksToSchedule.map((task) => limit(task));

    devLog(
      '[performParallelSearch] 开始执行',
      limitedTasks.length,
      '个任务',
      startFromTaskIndex > 0 ? `(从第 ${startFromTaskIndex + 1} 个续跑)` : ''
    );

    let completedCount = startFromTaskIndex;
    parallelCompletedCount = startFromTaskIndex;

    // 每个任务完成即立刻合并展示，不等其它任务
    const totalTaskCount = tasksToSchedule.length;
    const processTask = (result: MergedLinks) => {
      if (mySeq !== searchSeq || state.value.paused) return;
      if (Object.keys(result).length > 0) {
        currentMerged = mergeMergedByType(currentMerged, result);
        setMerged(currentMerged);
        setTotal(
          Object.values(currentMerged).reduce(
            (sum, arr) => sum + (arr?.length || 0),
            0
          )
        );
        devLog('[performParallelSearch] 有数据即展示，当前总数:', Object.values(currentMerged).reduce((s, a) => s + a.length, 0));
      }
      completedCount++;
      parallelCompletedCount = completedCount;

      // 结果达到本轮上限且还有剩余任务 → 自动暂停：
      // 停止剩余请求（进行中 abort，排队中跳过），省服务器资源；用户点"继续"再搜下一轮
      if (completedCount < totalTaskCount) {
        const curTotal = Object.values(currentMerged).reduce(
          (sum, arr) => sum + (arr?.length || 0),
          0
        );
        if (curTotal >= targetMax) {
          autoPausedAtLimit.value = true;
          setPaused(true);
          pausedAtTaskIndex = completedCount;
          cancelActiveRequests();
        }
      }
    };

    const wrapped = limitedTasks.map((limitedTask) =>
      limitedTask
        .then((result) => {
          processTask(result);
          return result;
        })
        .catch((err) => {
          devError('[performParallelSearch] 任务错误:', err);
        })
    );

    await Promise.all(wrapped);
    devLog('[performParallelSearch] 所有任务完成');
  }

  /**
   * SSE 流式搜索（2026-08-24 架构改造）：
   * - 1 个 /api/search.stream 长连接承载整个搜索，服务端逐批推送 chunk
   * - 前端边收边增量合并渲染 → 视觉上和旧分批模式一样"持续出结果"
   * - 自动暂停 90 条：收到 chunk 后检查累计总数，达阈值 abort 流 + 暂停
   * - 返回 { usedFallback }：true 表示流式不可用，调用方应回退旧分批模式
   */
  async function performStreamSearch(
    options: SearchOptions,
    mySeq: number,
    initialMerged?: MergedLinks,
    initialTotal = 0,
    /** 本轮目标结果上限（首搜不传=后端默认 90；「继续」传 已收+90，由后端自己计数停止） */
    maxResults?: number,
    /** 广告解锁票据（2026-09-04：402 后看完广告重试时带上，服务端验票清零放行） */
    unlockTicket?: UnlockTicket | null,
    /** 是否允许 402 时弹广告解锁（重试一次后关闭，防解锁失败死循环） */
    allowUnlockRetry = true
  ): Promise<{ usedFallback: boolean }> {
    const { apiBase, keyword, onAuthRequired } = options;

    // 2026-08-25 用户拍板：前端不传插件/并发/源类型（插件与频道都在后端，
    // 前端只传搜索词 + 继续时的目标总数）。后端自己决定插件与频道、并发与停止。
    const q = new URLSearchParams({
      kw: keyword,
    });
    // 后端自己计数停止：首搜不传（后端默认 90），「继续」传目标总数
    if (maxResults != null && maxResults > 0) q.set("maxResults", String(maxResults));
    // 断点续跑（2026-08-25）：回传已完成任务索引 + 前端已有结果数，
    // 后端只跑未搜任务、按"已有+本轮新增"判断是否达上限
    if (completedTaskGidx.size > 0) {
      q.set("skipTasks", [...completedTaskGidx].join(","));
    }
    if (initialTotal > 0) {
      q.set("initialTotal", String(initialTotal));
    }

    const controller = new AbortController();
    activeControllers.push(controller);

    let currentMerged: MergedLinks = initialMerged ? { ...initialMerged } : {};
    let curTotal = initialTotal;

    try {
      const resp = await fetch(`${apiBase}/search.stream?${q.toString()}`, {
        credentials: "include",
        signal: controller.signal,
        headers: {
          accept: "text/event-stream",
          // 402 解锁重试：带一次性票据头，服务端验票核销后清零配额放行
          ...(unlockTicket
            ? {
                "x-unlock-ticket": unlockTicket.ticket,
                "x-unlock-grant": unlockTicket.grant,
              }
            : {}),
        },
      });

      if (resp.status === 401) {
        onAuthRequired?.();
        return { usedFallback: false };
      }
      if (resp.status === 402) {
        // 页面端免费配额用完（2026-09-04）：弹 floating-unlock 广告弹窗，
        // 看完激励视频广告拿到 {ticket, grant} 后原参重发一次（此时无任何
        // chunk 已消费，状态零丢失）；取消/失败则终止本次搜索并提示。
        if (allowUnlockRetry && options.onQuotaExceeded) {
          const ticket = await options.onQuotaExceeded();
          if (ticket) {
            return performStreamSearch(
              options,
              mySeq,
              initialMerged,
              initialTotal,
              maxResults,
              ticket,
              false
            );
          }
        }
        setError("免费搜索次数已用完，观看视频广告后可继续搜索");
        return { usedFallback: false };
      }
      if (!resp.ok) {
        devWarn(`[useSearch] SSE HTTP ${resp.status}，回退分批模式`);
        return { usedFallback: true };
      }
      if (!resp.body) {
        devWarn("[useSearch] SSE 无 body，回退分批模式");
        return { usedFallback: true };
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // 循环读流，按 \n\n 分割事件块
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sepIdx = -1;
        while ((sepIdx = buffer.indexOf("\n\n")) >= 0) {
          const raw = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + 2);
          const evt = parseSSEEventBlock(raw);
          if (!evt) continue;

          // 搜索被重置/暂停时中断读流
          if (mySeq !== searchSeq || state.value.paused) {
            controller.abort();
            return { usedFallback: false };
          }

          if (evt.event === "chunk") {
            try {
              const payload = JSON.parse(evt.data);
              if (payload.merged) {
                currentMerged = mergeMergedByType(currentMerged, payload.merged);
                curTotal = Object.values(currentMerged).reduce(
                  (sum, arr) => sum + (arr?.length || 0),
                  0
                );
                setMerged(currentMerged);
                setTotal(curTotal);
              }
              // 自动暂停由后端控制（2026-08-25 用户拍板：后端自己计数，
              // 达到结果上限即停止剩余请求），前端不在 chunk 层 abort。
              // 后端停止后推 done(reachedLimit=true)，前端在 done 处理暂停 UI。
            } catch (e) {
              devWarn("[useSearch] SSE chunk 解析失败", e);
            }
          } else if (evt.event === "done") {
            try {
              const payload = JSON.parse(evt.data);
              // done 事件带 merged：与 chunk 一样做合并去重，绝不直接覆盖
              // —— 后端 acc 是本次连接从头累积的快照，继续搜索时缓存部分
              // 失效会导致 acc < 前端已有，直接 setMerged 会丢数据
              // （用户反馈 126 → 97）。
              // 首搜时 currentMerged={}，合并空集 = 插件结果，兜底语义不变。
              if (payload.merged && Object.keys(payload.merged).length > 0) {
                currentMerged = mergeMergedByType(currentMerged, payload.merged);
                setMerged(currentMerged);
              }
              // total 始终用前端真实 currentMerged 重算，不信后端
              // payload.total（继续搜索时 payload.total 是后端本次 acc
              // 视角，可能 < 前端已有），避免数字被覆盖变小
              curTotal = Object.values(currentMerged).reduce(
                (sum, arr) => sum + (arr?.length || 0),
                0
              );
              setTotal(curTotal);
              // 断点续跑：累积后端回传的已完成任务索引（下次继续时回传
              // skipTasks，后端只跑未搜过的任务）
              if (Array.isArray(payload.completedIndices)) {
                for (const i of payload.completedIndices) {
                  const n = Number(i);
                  if (Number.isFinite(n)) completedTaskGidx.add(n);
                }
              }
              // reachedLimit=true：后端已因结果达到上限停止剩余请求。
              // 前端只负责展示"已找到 N 条，点击继续"（服务端真的停了，
              // 继续 = 重新连流，只跑未搜任务 + 累积结果）
              if (payload.reachedLimit) {
                autoPausedAtLimit.value = true;
                setPaused(true);
                // ⚠️ 修复（2026-08-25）：这里绝不能 setLoading(false)！
                // "继续"按钮显示条件是 loading && paused（SearchBox.vue:86），
                // 置 false 后按钮消失，页面只剩"搜索"按钮；用户以为点的
                // "继续"实际是 onSearch → resetSearch → 清空进度重新从头搜
                // （无 skipTasks/initialTotal）→ 第二次结果漂移/重复首轮。
                // paused 时保持 loading=true 让"继续"按钮可见可点。
              }
            } catch {}
            return { usedFallback: false };
          } else if (evt.event === "error") {
            try {
              const payload = JSON.parse(evt.data);
              setError(payload.message || "搜索异常");
            } catch {}
            return { usedFallback: false };
          }
        }
      }

      return { usedFallback: false };
    } catch (error: any) {
      // 主动 abort（暂停/重置）不算失败
      const isAbort =
        error?.name === "AbortError" ||
        error?.cause?.name === "AbortError" ||
        error?.cause?.cause?.name === "AbortError";
      if (isAbort) return { usedFallback: false };
      devWarn("[useSearch] SSE 流异常，回退分批模式:", error);
      return { usedFallback: true };
    } finally {
      const idx = activeControllers.indexOf(controller);
      if (idx >= 0) activeControllers.splice(idx, 1);
    }
  }

  /** URL ?stream=0 强制走旧分批模式（故障逃生） */
  function isStreamDisabledByQuery(): boolean {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("stream") === "0";
  }

  // 主搜索函数
  async function performSearch(options: SearchOptions): Promise<void> {    const { keyword, settings } = options;

    // 验证
    if (!keyword || keyword.trim().length === 0) {
      setError("请输入搜索关键词");
      return;
    }

    // iOS Safari 兼容性：确保输入框失去焦点
    if (
      typeof window !== "undefined" &&
      document.activeElement instanceof HTMLInputElement
    ) {
      document.activeElement.blur();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // 重置状态
    setLoading(true);
    setError("");
    setSearched(true);
    setElapsedMs(0);
    setTotal(0);
    setMerged({});
    setDeepLoading(false);
    // 新一轮搜索：清空断点续跑进度（已完成任务索引重新开始记录）
    completedTaskGidx.clear();

    const mySeq = ++searchSeq;
    const start = performance.now();

    try {
      if (USE_STREAM_SEARCH && !isStreamDisabledByQuery()) {
        // SSE 流式（2026-08-24 架构改造）：1 个长连接，服务端逐批推送
        const { usedFallback } = await performStreamSearch(options, mySeq, undefined, 0);
        if (!usedFallback) {
          if (mySeq !== searchSeq) return;
        } else {
          // fallback：流式不可用（404/网络异常）→ 回退旧的 countOnly + batch 并发
          devWarn("[useSearch] SSE 流式不可用，回退分批模式");
          if (lastCountedKeyword !== keyword) {
            lastTotalTgBatches = await fetchTgBatchCount(options.apiBase, keyword);
            lastCountedKeyword = keyword;
          }
          await performParallelSearch(options, mySeq, 0, undefined, lastTotalTgBatches);
        }
      } else {
        // 旧模式：countOnly + N 个 batch 并发
        if (lastCountedKeyword !== keyword) {
          lastTotalTgBatches = await fetchTgBatchCount(options.apiBase, keyword);
          lastCountedKeyword = keyword;
        }
        await performParallelSearch(options, mySeq, 0, undefined, lastTotalTgBatches);
      }

      if (mySeq !== searchSeq) return;
    } catch (error: any) {
      setError(error?.data?.message || error?.message || "请求失败");
    } finally {
      setElapsedMs(Math.round(performance.now() - start));
      // 如果暂停了，保持 loading 状态，只取消 deepLoading
      if (!state.value.paused) {
        setLoading(false);
      }
      setDeepLoading(false);
    }
  }

  // 重置搜索
  function resetSearch(): void {
    cancelActiveRequests();
    searchSeq++;
    autoPausedAtLimit.value = false;
    // 清空断点续跑进度（重置 = 新搜索从头开始）
    completedTaskGidx.clear();
    setLoading(false);
    setDeepLoading(false);
    setPaused(false);
    setError("");
    setSearched(false);
    setElapsedMs(0);
    setTotal(0);
    setMerged({});
  }

  // 复制链接
  async function copyLink(url: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      return false;
    }
  }

  // 响应式状态
  const loading = computed(() => state.value.loading);
  const deepLoading = computed(() => state.value.deepLoading);
  const paused = computed(() => state.value.paused);
  const error = computed(() => state.value.error);
  const searched = computed(() => state.value.searched);
  const elapsedMs = computed(() => state.value.elapsedMs);
  const total = computed(() => state.value.total);
  const merged = computed(() => state.value.merged);
  const hasResults = computed(() => Object.keys(state.value.merged).length > 0);

  return {
    state,
    loading,
    deepLoading,
    paused,
    error,
    searched,
    elapsedMs,
    total,
    merged,
    hasResults,
    autoPausedAtLimit: computed(() => autoPausedAtLimit.value),
    performSearch,
    resetSearch,
    copyLink,
    cancelActiveRequests,
    pauseSearch,
    continueSearch,
  };
}
