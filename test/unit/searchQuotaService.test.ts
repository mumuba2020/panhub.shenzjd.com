import {
  consumeQuota,
  resetQuota,
  getQuotaUsed,
  resetAllQuotas,
  FREE_SEARCH_LIMIT,
} from "../../server/core/services/searchQuotaService";

describe("searchQuotaService（页面端搜索配额，内存计数）", () => {
  beforeEach(() => {
    resetAllQuotas();
  });

  it("免费额度内累计计数：1/2/3 次均不超限", () => {
    expect(consumeQuota("oABC")).toBe(1);
    expect(consumeQuota("oABC")).toBe(2);
    expect(consumeQuota("oABC")).toBe(3);
    expect(consumeQuota("oABC")).toBeGreaterThan(FREE_SEARCH_LIMIT);
  });

  it("超过 FREE_SEARCH_LIMIT 后每次 consume 仍递增（超限判定由调用方做）", () => {
    for (let i = 0; i < FREE_SEARCH_LIMIT + 1; i++) consumeQuota("oABC");
    expect(consumeQuota("oABC")).toBe(FREE_SEARCH_LIMIT + 2);
  });

  it("resetQuota 清零后重新计数（广告验票通过后放开）", () => {
    for (let i = 0; i < FREE_SEARCH_LIMIT + 2; i++) consumeQuota("oABC");
    resetQuota("oABC");
    expect(getQuotaUsed("oABC")).toBe(0);
    expect(consumeQuota("oABC")).toBe(1);
  });

  it("不同 openid 计数互相隔离", () => {
    consumeQuota("oA");
    consumeQuota("oA");
    expect(consumeQuota("oB")).toBe(1);
    expect(getQuotaUsed("oA")).toBe(2);
  });

  it("getQuotaUsed 无记录返回 0，reset 未记录的 openid 也安全", () => {
    expect(getQuotaUsed("nobody")).toBe(0);
    expect(() => resetQuota("nobody")).not.toThrow();
  });

  it("resetAllQuotas 清空全部计数（测试隔离用）", () => {
    consumeQuota("oA");
    consumeQuota("oB");
    resetAllQuotas();
    expect(getQuotaUsed("oA")).toBe(0);
    expect(getQuotaUsed("oB")).toBe(0);
  });
});
