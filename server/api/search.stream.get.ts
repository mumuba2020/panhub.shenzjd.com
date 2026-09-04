import {
  defineEventHandler,
  getQuery,
  getRequestHeader,
  createError,
  createEventStream,
} from "h3";
import type { H3Event } from "h3";
import { requireHumanOrCredential, requireWxAuth } from "../utils/requireAuth";
import { getBearerToken, isAdminUser } from "../utils/wxAuthCheck";
import {
  consumeQuota,
  resetQuota,
  FREE_SEARCH_LIMIT,
} from "../core/services/searchQuotaService";
import {
  verifyUnlockGrant,
  getUnlockTicketFromHeaders,
} from "../utils/unlockVerify";
import { maybeRecordHoneypotOpenid } from "../utils/recordHoneypotOpenid";
import { isSearchRateLimited } from "../utils/entryRateLimit";
import { parseList } from "../utils/parseQuery";
import { recordSearchTerm } from "../utils/recordSearchTerm";
import { getClientIp } from "../middleware/rateLimiter";
import { getOrCreateBotDefenseService } from "../core/services/botDefense";
import { buildBlockedFakeMerged } from "../core/utils/blockedFakeData";
import { getOrCreateSearchService } from "../core/services";
import { getChannelConfigService } from "../core/services/channelConfigService";
import { loggers } from "../core/utils/logger";
import { sliceBatchChannels } from "../core/utils/batchChannels";
import type { SearchRequest, MergedLinks } from "../core/types/models";

/**
 * SSE 搜索流端点（2026-08-24 用户拍板架构改造）
 *
 * 背景：一次搜索原本 = 前端并发 35+ 个子请求（countOnly + 各 batch + 各插件），
 * 每个子请求都触发 wx-auth 校验 → 打爆限流。频道已零落地到后端，前端
 * 不再需要知道批次。
 *
 * 本端点：**1 个 SSE 连接承载整个搜索**——
 * - 建立连接时只做 1 次 wx-auth 校验（复用 10s 缓存）
 * - 后端把 TG 频道按 batchSize 切片，受控并发逐批抓取
 * - 每完成一批 push 一个 chunk 事件（增量结果），前端边收边渲染
 * - 全部完成 push done 事件（汇总 total）
 * - 频道名不出现在任何事件里（零落地保持）
 *
 * 事件协议（data 为 JSON 字符串）：
 *   event: chunk  data: {"done":N,"total":M,"merged":{type:[...]}}
 *   event: done   data: {"total":N,"warnings":[...]}
 *   event: error  data: {"message":"..."}
 *
 * 客户端断开：eventStream.onClosed → abort 内部搜索 → close
 */

/** 服务端每批抓取的频道数（TG 频道限流友好 + 批次数量可控） */
const TG_BATCH_SIZE = 6;
/** 后端批次并发数（受控，避免一次拉起全部批次） */
const TG_BATCH_CONCURRENCY = 4;
/** 客户端断开后，后端最多再等多久清理（防止挂起的 fetch 无限占资源） */
const CLOSE_GRACE_MS = 2_000;
/** 本轮结果上限默认值（用户拍板：结果 ≥ 此值即停止剩余请求节省资源） */
const SEARCH_MAX_RESULTS_DEFAULT = 90;

export default defineEventHandler(async (event: H3Event) => {
  // ---- 入口鉴权（只做一次）----
  const ip = getClientIp(event);
  if (await getOrCreateBotDefenseService().isBlocked(ip)) {
    // 2026-08-27 改为蜜罐假数据：不再 403（爬虫收到 403 仍会继续请求），
    // 改为推一次 chunk（含 merged 假数据）+ done，协议与正常流完全一致，
    // 无论搜什么都是同一份纯静态公众号宣传内容，不触发真实搜索。
    loggers.search.debug(`黑名单 IP 命中，返回蜜罐假数据(stream)`, {
      ip,
      method: event.method,
      path: event.path,
    });
    // 2026-09-03：带凭证真实用户被误伤时异步记录 openid↔ip（见 recordHoneypotOpenid）
    maybeRecordHoneypotOpenid(event, ip);
    const fakeStream = createEventStream(event);
    const merged = buildBlockedFakeMerged();
    const total = Object.values(merged).reduce(
      (sum, arr) => sum + arr.length,
      0
    );
    // ⚠️ 2026-08-27 修复：h3 createEventStream 是惰性的，push() 必须在
    // send() 之后才会真正写入流；在 send() 前 await push() 会永不 resolve
    // （handler 卡死 → CF 等源站直到超时 → SSE 一直 pending，线上实测）。
    // 必须与正常分支同构：后台任务里 push，主 handler 立即 return send()。
    void (async () => {
      await fakeStream.push({
        event: "chunk",
        data: JSON.stringify({ done: 1, total, merged }),
      });
      await fakeStream.push({
        event: "done",
        data: JSON.stringify({
          total,
          warnings: [],
          pluginCount: 0,
          merged,
          completedIndices: [0],
          reachedLimit: false,
        }),
      });
      await fakeStream.close();
    })();
    return fakeStream.send();
  }
  // 搜索入口 IP 频控（2026-08-25）：60s 内超过阈值（默认 30 次）→ 429
  if (await isSearchRateLimited(ip)) {
    throw createError({ statusCode: 429, statusMessage: "too many requests" });
  }
  requireHumanOrCredential(event);
  // 微信关注公众号登录态校验（恒强制）。三态：
  // - "ok"           → 放行
  // - "honeypot"     → 无凭证（爬虫/直调）→ 返回蜜罐流式假数据帮我们传播公众号
  // - "unauthorized" → 有凭证但失效（取消关注真人）→ 401 触发前端重新引导关注
  const wxAuth = await requireWxAuth(event);
  if (wxAuth === "honeypot") {
    loggers.search.debug(`无凭证请求，返回蜜罐假数据(stream)`, {
      ip,
      method: event.method,
      path: event.path,
    });
    const fakeStream = createEventStream(event);
    const merged = buildBlockedFakeMerged();
    const total = Object.values(merged).reduce(
      (sum, arr) => sum + arr.length,
      0
    );
    // 与黑名单分支同构：先 push 后 send（h3 createEventStream 惰性，
    // push 必须在 send() 之后才真正写入流，见黑名单分支注释）
    void (async () => {
      await fakeStream.push({
        event: "chunk",
        data: JSON.stringify({ done: 1, total, merged }),
      });
      await fakeStream.push({
        event: "done",
        data: JSON.stringify({
          total,
          warnings: [],
          pluginCount: 0,
          merged,
          completedIndices: [0],
          reachedLimit: false,
        }),
      });
      await fakeStream.close();
    })();
    return fakeStream.send();
  }
  if (wxAuth === "unauthorized") {
    throw createError({ statusCode: 401, statusMessage: "wx auth required" });
  }

  // ---- 页面端搜索配额（2026-09-04 接入 floating-unlock 看广告解锁）----
  // 每次建流（「搜索」或「继续」）计 1 次，免费 FREE_SEARCH_LIMIT 次；
  // 超限返回 402，前端弹 floating-unlock 广告弹窗，看完广告重试时带
  // X-Unlock-Ticket / X-Unlock-Grant 头，服务端验票核销后清零放行。
  // 豁免：小程序端（Bearer 凭证，页面端限制不适用）与管理员。
  if (!getBearerToken(event) && !(await isAdminUser(event))) {
    const unlockTicket = getUnlockTicketFromHeaders(
      getRequestHeader(event, "x-unlock-ticket"),
      getRequestHeader(event, "x-unlock-grant")
    );
    if (unlockTicket) {
      // 有票据：验真并核销（grant 一次性），通过即清零计数放行本次搜索；
      // 不通过 fail-closed 402（不消耗新配额，前端可重新解锁再试）
      const valid = await verifyUnlockGrant(unlockTicket);
      if (!valid) {
        throw createError({
          statusCode: 402,
          statusMessage: "unlock grant invalid",
          data: { code: "QUOTA_EXCEEDED", freeLimit: FREE_SEARCH_LIMIT },
        });
      }
      const openid = ((event.context as Record<string, any>)?.__wxAuthOpenid as string) || "";
      resetQuota(openid);
    } else {
      const openid = ((event.context as Record<string, any>)?.__wxAuthOpenid as string) || "";
      const used = consumeQuota(openid);
      if (used > FREE_SEARCH_LIMIT) {
        throw createError({
          statusCode: 402,
          statusMessage: "search quota exceeded",
          data: { code: "QUOTA_EXCEEDED", used, freeLimit: FREE_SEARCH_LIMIT },
        });
      }
    }
  }

  const config = useRuntimeConfig();
  await getChannelConfigService().ensureLoaded();
  const service = getOrCreateSearchService(config);
  const q = getQuery(event);

  const kw = ((q.kw as string) || "").trim();
  if (!kw) {
    throw createError({ statusCode: 400, statusMessage: "kw is required" });
  }
  if (kw.length > 200) {
    throw createError({ statusCode: 400, statusMessage: "kw too long (max 200)" });
  }

  await recordSearchTerm(
    kw,
    ip,
    // 2026-08-25：requireWxAuth 已把 openid 存进
    // event.context（见 wxAuthCheck.ts），搜索日志用它关联"谁搜了什么"
    ((event.context as Record<string, any>)?.__wxAuthOpenid as string) || ""
  );

  let ext: Record<string, any> | undefined;
  const extStr = (q.ext as string | undefined)?.trim();
  if (extStr) {
    if (extStr === "{}") ext = {};
    else {
      try {
        ext = JSON.parse(extStr);
      } catch {
        throw createError({ statusCode: 400, statusMessage: "invalid ext json" });
      }
    }
  }

  const allChannels = getChannelConfigService().getSnapshot().defaultChannels;
  const src = (q.src as any) || "all";
  // 2026-08-25 用户拍板：前端不传插件知识（插件在后端注册表，全部启用）。
  // 前端 URL 里即使带 plugins 参数也忽略（防御：插件选择权完全在后端）。
  const cloudTypes = parseList(q.cloud_types);
  const res = (q.res as any) || "merged_by_type";
  const refresh = String(q.refresh).trim() === "true";

  // 本轮结果上限（2026-08-25 用户拍板：后端自己计数，达到即停止剩余请求）。
  // - 首搜不传 = 默认 90（后端常量 SEARCH_MAX_RESULTS_DEFAULT）
  // - 「继续」时前端传目标总数 = 已收 + 90（如 180/270…），后端累计到该值停止
  // 服务端在每次任务完成后自检累计，达到即 abort 剩余任务 + push done(reachedLimit=true)
  const maxResultsRaw = parseInt(String(q.maxResults ?? ""), 10);
  const maxResults = Number.isFinite(maxResultsRaw) && maxResultsRaw >= 1 ? maxResultsRaw : SEARCH_MAX_RESULTS_DEFAULT;

  // 断点续跑（2026-08-25 用户拍板：前端记录已搜任务进度，继续时回传，
  // 后端只跑未搜过的任务——否则"继续"= 从头重跑所有任务，缓存失效时
  // 结果数量会变，且已搜频道被重复抓取）：
  // - skipTasks：上次已完成的任务全局索引 gidx（逗号分隔），本轮跳过
  // - initialTotal：前端已有结果数，参与上限判断（目标 = 已有 + 本轮新增）
  const skipSet = new Set(
    String(q.skipTasks ?? "")
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n >= 0)
  );
  const initialTotalRaw = parseInt(String(q.initialTotal ?? ""), 10);
  const initialTotal = Number.isFinite(initialTotalRaw) && initialTotalRaw >= 0 ? initialTotalRaw : 0;

  const conc = (() => {
    const n = q.conc ? parseInt(String(q.conc), 10) : NaN;
    return Number.isFinite(n) && n >= 1 && n <= 16 ? n : undefined;
  })();

  const req: SearchRequest = {
    kw,
    channels: undefined,
    conc,
    refresh,
    res,
    src,
    plugins: undefined, // 插件由后端注册表决定（2026-08-25）
    cloud_types: cloudTypes,
    ext,
  };
  if (req.src === "tg") req.plugins = undefined;
  else if (req.src === "plugin") req.channels = undefined;
  if (!req.res || req.res === "merge") req.res = "merged_by_type";

  // ---- 建立 SSE 流 ----
  const stream = createEventStream(event);
  const abortController = new AbortController();
  const signal = abortController.signal;

  stream.onClosed(() => {
    // 客户端断开：先给内部搜索一个 grace 期让它自然收尾，再强制 abort
    setTimeout(() => abortController.abort(), CLOSE_GRACE_MS);
  });

  const push = (eventName: string, data: unknown): Promise<void> =>
    stream.push({ event: eventName, data: JSON.stringify(data) });

  // 后台执行搜索并逐批推送；主 handler 返回 stream.send() 保持连接
  void (async () => {
    try {
      // 任务统一进并发池：TG 批次 + 各插件源，谁先完成谁先 push chunk
      // → 前端"边搜边出"，不等所有任务完成
      const pLimit = (await import("p-limit")).default;
      // 按类型分两个并发池（TG_BATCH_CONCURRENCY 各自一份）：
      // 插件池和 TG 池互相独立，避免慢的 TG 占满限流槽位"堵死"插件
      // （生产 TG 通道很快，dev 环境 TG 受限超时，会让插件晚到 9+ 秒）
      const tgLimit = pLimit(TG_BATCH_CONCURRENCY);
      const pluginLimit = pLimit(TG_BATCH_CONCURRENCY);

      const totalBatches = Math.max(1, Math.ceil(allChannels.length / TG_BATCH_SIZE));
      // 插件列表由后端自己持有（2026-08-25 用户拍板：前端不传插件知识，
      // 插件在后端注册表里，全部启用，与频道一样后端化）。
      // service.getPluginManager().getPlugins() 返回全部已注册插件，
      // 按名字切片交给 searchWithWarnings 逐源执行。
      const enabledPlugins =
        src === "all" || src === "plugin"
          ? service
              .getPluginManager()
              .getPlugins()
              .map((p) => p.name())
              .filter(Boolean)
          : [];

      // 构建任务列表。gidx 为全局唯一任务索引（tg 批 0..N-1、plugin N..N+M-1），
      // 用于断点续跑：前端回传已完成 gidx，本轮跳过这些任务只跑剩余
      interface Task {
        type: "tg" | "plugin";
        /** 类型内索引（tg 批序号 / 插件序号），供切片与取插件名用 */
        index: number;
        /** 全局唯一任务索引（跨类型），供 skipTasks 断点续跑用 */
        gidx: number;
      }
      let gidx = 0;
      const tgTasks: Task[] = [];
      for (let i = 0; i < totalBatches; i++)
        tgTasks.push({ type: "tg", index: i, gidx: gidx++ });
      const pluginTasks: Task[] = [];
      for (let i = 0; i < enabledPlugins.length; i++)
        pluginTasks.push({ type: "plugin", index: i, gidx: gidx++ });

      // 断点续跑：跳过前端回传的已完成任务（gidx 全局唯一，tg/plugin 不冲突）
      const pendingTgTasks = tgTasks.filter((t) => !skipSet.has(t.gidx));
      const pendingPluginTasks = pluginTasks.filter((t) => !skipSet.has(t.gidx));
      const total = pendingTgTasks.length + pendingPluginTasks.length;
      let done = 0;
      let acc: MergedLinks = {};
      /** 本次连接实际完成任务（gidx 集合），done 事件回传前端用于下次断点 */
      const completedGidx: number[] = [];
      /** 是否已因达到结果上限而触发停止（后端自己计数，2026-08-25 用户拍板） */
      let limitReached = false;
      const warnings: string[] = [];

      const runTask = async (task: Task) => {
        // 客户端断开 或 已达结果上限 → 跳过（limit 用独立标志，不 abort
        // signal，保证 done 事件仍能推送 reachedLimit=true）
        if (signal.aborted || limitReached) return;
        try {
          let batchMerged: MergedLinks = {};
          if (task.type === "tg") {
            const batchChannels = sliceBatchChannels(
              allChannels,
              task.index,
              TG_BATCH_SIZE
            );
            if (batchChannels.length > 0) {
              const { response, warnings: w } = await service.searchWithWarnings(
                kw,
                batchChannels,
                conc,
                refresh,
                "merged_by_type",
                "tg",
                undefined,
                undefined,
                // 深搜只允许最后一批触发（防每批都翻页 CPU 炸弹）
                { ...(ext || {}), __deep_search: task.index === totalBatches - 1 },
                signal
              );
              if (w.length > 0) warnings.push(...w);
              if (response.merged_by_type) {
                batchMerged = response.merged_by_type;
              }
            }
          } else {
            // 单个插件独立成任务（plugins 传 [name] 让 searchPlugins 内部只跑这个）
            const { response, warnings: w } = await service.searchWithWarnings(
              kw,
              undefined,
              conc,
              refresh,
              "merged_by_type",
              "plugin",
              [enabledPlugins[task.index]],
              cloudTypes,
              ext || {},
              signal
            );
            if (w.length > 0) warnings.push(...w);
            if (response.merged_by_type) {
              batchMerged = response.merged_by_type;
            }
          }
          if (Object.keys(batchMerged).length > 0) {
            acc = mergeMergedByType(acc, batchMerged);
          }
        } catch (err) {
          loggers.search.warn(`SSE ${task.type} 任务失败`, {
            keyword: kw,
            task,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        done++;
        // 记录已完成任务的全局索引，done 事件回传前端用于下次断点续跑
        completedGidx.push(task.gidx);
        if (!signal.aborted) {
          // 后端自检结果上限（用户拍板：达到即停止剩余请求节省资源）。
          // 只置 limitReached 标志让剩余任务跳过（不 abort signal），
          // 这样 done 事件一定能推（带 reachedLimit=true）
          // curTotal 是"本轮新增"（acc 只含本次连接结果），加上前端已有
          // initialTotal 才是累计总数 → 与 maxResults（已有+90）对齐
          const curTotal = Object.values(acc).reduce(
            (sum, arr) => sum + arr.length,
            0
          );
          // ⚠️ 2026-08-25 修复：只有"仍有剩余任务"时才算提前停止。
          // 此前只要 curTotal >= maxResults 就置 true —— 若最后一批刚好把
          // 总数推过上限（如 126 ≥ 90）而全部任务已跑完（done===total），
          // 会误报 reachedLimit → 前端显示无意义的"点击继续"，
          // 点继续后后端重跑全部任务（缓存秒回同样结果）→ 数量不变，
          // 用户感知"第二次重复了第一次"（无"已搜进度"记录）。
          if (curTotal + initialTotal >= maxResults && done < total) {
            limitReached = true;
          }
          // 累计快照推 chunk：前端简单 setMerged(acc) 即可，
          // 避免增量协议下"丢/重"的复杂合并逻辑
          await push("chunk", {
            done,
            total,
            merged: acc,
          });
        }
      };

      // 并发执行（断点续跑时只跑未完成任务）：TG 池 + 插件池互相独立，
      // 慢的 TG 不会"堵"插件。达到结果上限后剩余任务在开头跳过
      await Promise.all([
        ...pendingTgTasks.map((task) => tgLimit(() => runTask(task))),
        ...pendingPluginTasks.map((task) => pluginLimit(() => runTask(task))),
      ]);

      // 汇总事件：done 带 merged 作为最终兜底（即使 chunk 全部空，
      // 插件结果也能保证送到前端）。reachedLimit 标记本轮是否因达到
      // 结果上限而提前停止且有任务被跳过（前端据此显示"点击继续"）
      const finalTotal = Object.values(acc).reduce(
        (sum, arr) => sum + arr.length,
        0
      );
      if (!signal.aborted) {
        await push("done", {
          total: finalTotal,
          warnings,
          pluginCount: enabledPlugins.length,
          merged: acc,
          // 已完成任务全局索引（断点续跑：前端累积后下次继续时回传 skipTasks）
          completedIndices: completedGidx,
          // 最终判定：只有"limitReached 且确有任务被跳过"才报 reachedLimit。
          // 并发槽位中的在途任务可能已把 done 追平 total（全部跑完），
          // 此时再报"继续"会让前端重复搜一遍相同结果
          reachedLimit: limitReached && done < total,
        });
      }
    } catch (err) {
      loggers.search.error("SSE 搜索异常", {
        keyword: kw,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!signal.aborted) {
        await push("error", {
          message: err instanceof Error ? err.message : "搜索异常",
        });
      }
    } finally {
      await stream.close();
    }
  })();

  return stream.send();
});

/** 按 url 去重合并（与前端 utils/mergeMergedByType 同逻辑，供后端增量累加） */
function mergeMergedByType(
  target: MergedLinks,
  incoming: MergedLinks
): MergedLinks {
  const out: MergedLinks = { ...target };
  for (const type of Object.keys(incoming)) {
    const existed = out[type] || [];
    const next = incoming[type] || [];
    const seen = new Set<string>(existed.map((x) => x.url));
    const mergedArr = [...existed];
    for (const item of next) {
      if (!seen.has(item.url)) {
        seen.add(item.url);
        mergedArr.push(item);
      }
    }
    out[type] = mergedArr;
  }
  return out;
}
