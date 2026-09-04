/**
 * TG 频道分批工具测试（2026-08-24）
 *
 * 验证 buildBatchPlan / sliceBatchChannels / parseBatchQuery 的边界
 * （批次越界、batchSize 钳制、countOnly 识别等）。
 */

import { describe, it, expect } from "vitest";
import {
  buildBatchPlan,
  sliceBatchChannels,
  parseBatchQuery,
} from "../../server/core/utils/batchChannels";

const SAMPLE_CHANNELS = [
  "a", "b", "c", "d", "e", "f", "g",
];

describe("buildBatchPlan", () => {
  it("ceil 切分（不满一批也算一批）", () => {
    expect(buildBatchPlan(SAMPLE_CHANNELS, 2)).toEqual({
      totalBatches: 4, // 7/2 ceil = 4
      batchSize: 2,
      totalChannels: 7,
    });
  });

  it("整除边界", () => {
    expect(buildBatchPlan(["a", "b", "c", "c"], 2)).toEqual({
      totalBatches: 2,
      batchSize: 2,
      totalChannels: 4,
    });
  });

  it("空频道也返回 1 批（不返回 0，前端循环会无限）", () => {
    expect(buildBatchPlan([], 2)).toEqual({
      totalBatches: 1,
      batchSize: 2,
      totalChannels: 0,
    });
  });

  it("batchSize 非法值兜底为 1", () => {
    expect(buildBatchPlan(["a", "b", "c"], 0).batchSize).toBe(1);
    expect(buildBatchPlan(["a", "b", "c"], -3).batchSize).toBe(1);
    expect(buildBatchPlan(["a", "b", "c"], 2.7).batchSize).toBe(2);
  });
});

describe("sliceBatchChannels", () => {
  it("正常切分每批 2 个", () => {
    expect(sliceBatchChannels(SAMPLE_CHANNELS, 0, 2)).toEqual(["a", "b"]);
    expect(sliceBatchChannels(SAMPLE_CHANNELS, 1, 2)).toEqual(["c", "d"]);
    expect(sliceBatchChannels(SAMPLE_CHANNELS, 2, 2)).toEqual(["e", "f"]);
    // 最后一批只有 1 个
    expect(sliceBatchChannels(SAMPLE_CHANNELS, 3, 2)).toEqual(["g"]);
  });

  it("越界 batch 返回空数组（不抛错）", () => {
    expect(sliceBatchChannels(SAMPLE_CHANNELS, 99, 2)).toEqual([]);
  });

  it("空频道返回空数组", () => {
    expect(sliceBatchChannels([], 0, 2)).toEqual([]);
  });

  it("非法 batch 索引（负数/NaN）返回空数组", () => {
    expect(sliceBatchChannels(SAMPLE_CHANNELS, -1, 2)).toEqual([]);
    expect(sliceBatchChannels(SAMPLE_CHANNELS, NaN, 2)).toEqual([]);
  });

  it("非数组输入兜底", () => {
    expect(sliceBatchChannels(null as any, 0, 2)).toEqual([]);
    expect(sliceBatchChannels(undefined as any, 0, 2)).toEqual([]);
  });
});

describe("parseBatchQuery", () => {
  it("缺省时返回 null batch + 默认 batchSize=2 + countOnly=false", () => {
    const r = parseBatchQuery({});
    expect(r.batch).toBe(null);
    expect(r.batchSize).toBe(2);
    expect(r.countOnly).toBe(false);
  });

  it("countOnly 识别多种写法", () => {
    expect(parseBatchQuery({ countOnly: "1" }).countOnly).toBe(true);
    expect(parseBatchQuery({ countOnly: "true" }).countOnly).toBe(true);
    expect(parseBatchQuery({ countOnly: true }).countOnly).toBe(true);
    expect(parseBatchQuery({ countOnly: "0" }).countOnly).toBe(false);
    expect(parseBatchQuery({ countOnly: "yes" }).countOnly).toBe(false);
  });

  it("batch 接受字符串数字", () => {
    expect(parseBatchQuery({ batch: "5" }).batch).toBe(5);
    expect(parseBatchQuery({ batch: 5 }).batch).toBe(5);
  });

  it("batch 非法值兜底为 null（不污染后续判断）", () => {
    expect(parseBatchQuery({ batch: "abc" }).batch).toBe(null);
    expect(parseBatchQuery({ batch: "" }).batch).toBe(null);
  });

  it("batchSize 钳制到 [1, 50] 区间", () => {
    expect(parseBatchQuery({ batchSize: 100 }).batchSize).toBe(50);
    expect(parseBatchQuery({ batchSize: 0 }).batchSize).toBe(1);
    expect(parseBatchQuery({ batchSize: -5 }).batchSize).toBe(1);
  });
});
