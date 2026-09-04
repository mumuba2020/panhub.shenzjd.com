import { describe, expect, it } from "vitest";
import {
  buildBlockedFakeGenericResponse,
  buildBlockedFakeMerged,
  buildBlockedFakeResponse,
} from "../../server/core/utils/blockedFakeData";

/**
 * 黑名单蜜罐假数据（2026-08-27 用户拍板）
 * 命中黑名单的搜索请求返回标准结构数据（纯静态公众号宣传），不再 403。
 */
describe("blockedFakeData 蜜罐假数据", () => {
  it("merged_by_type 结构合法：多盘型分组 + 每条含 url/note/datetime", () => {
    const merged = buildBlockedFakeMerged();

    // 至少包含 baidu / quark 两个主流盘型，模拟正常聚合结果
    expect(Object.keys(merged).length).toBeGreaterThanOrEqual(2);
    for (const [type, items] of Object.entries(merged)) {
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.url).toBeTruthy();
        expect(item.note).toBeTruthy();
        expect(item.datetime).toBeTruthy();
        // 宣传文案必须出现公众号名称
        expect(item.note).toContain("神族九帝");
      }
    }
  });

  it("SearchResponse 结构：total 与 merged 条目数一致", () => {
    const resp = buildBlockedFakeResponse();
    expect(resp.merged_by_type).toBeDefined();
    const sum = Object.values(resp.merged_by_type!).reduce(
      (acc, arr) => acc + arr.length,
      0
    );
    expect(resp.total).toBe(sum);
    expect(resp.total).toBeGreaterThan(0);
  });

  it("GenericResponse 包装：code=0 / message=success / data 为 SearchResponse", () => {
    const generic = buildBlockedFakeGenericResponse();
    expect(generic.code).toBe(0);
    expect(generic.message).toBe("success");
    expect(generic.data?.merged_by_type).toBeDefined();
  });

  it("纯静态：两次调用内容一致（无论搜什么都返回同一份）", () => {
    const a = buildBlockedFakeMerged();
    const b = buildBlockedFakeMerged();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
