/**
 * TG 频道分批工具（2026-08-24）
 *
 * 为实现"频道零落地"：前端只传批次号（batch + batchSize），
 * 后端从 channelConfigService 快照里切片出该批频道去抓。
 * 频道名永不出现在前端代码、URL、HTML 或 API 响应里。
 */

export interface BatchPlan {
  totalBatches: number;
  batchSize: number;
  totalChannels: number;
}

export function buildBatchPlan(
  allChannels: string[],
  batchSize: number
): BatchPlan {
  const size = Math.max(1, Math.floor(batchSize));
  return {
    totalBatches: Math.max(1, Math.ceil(allChannels.length / size)),
    batchSize: size,
    totalChannels: allChannels.length,
  };
}

export function sliceBatchChannels(
  allChannels: string[],
  batchIndex: number,
  batchSize: number
): string[] {
  if (!Array.isArray(allChannels) || allChannels.length === 0) return [];
  if (!Number.isFinite(batchIndex) || batchIndex < 0) return [];
  const size = Math.max(1, Math.floor(batchSize));
  const start = batchIndex * size;
  if (start >= allChannels.length) return [];
  return allChannels.slice(start, start + size);
}

/**
 * 解析 search 接口的 batch 参数（统一 GET/POST）
 * 返回 { batch, batchSize, countOnly }，batch/countOnly 缺省为 null
 */
export function parseBatchQuery(input: Record<string, unknown> | undefined): {
  batch: number | null;
  batchSize: number;
  countOnly: boolean;
} {
  const q = input || {};
  const batchRaw = (q as any).batch;
  const sizeRaw = (q as any).batchSize;
  const countRaw = (q as any).countOnly;
  const batch =
    batchRaw == null || batchRaw === ""
      ? null
      : Number(batchRaw);
  const batchSize = Math.max(
    1,
    Math.min(
      50,
      sizeRaw == null || sizeRaw === "" ? 2 : Math.floor(Number(sizeRaw))
    )
  );
  const countOnly = countRaw === "1" || countRaw === "true" || countRaw === true;
  return {
    batch: batch != null && Number.isFinite(batch) ? batch : null,
    batchSize,
    countOnly,
  };
}
