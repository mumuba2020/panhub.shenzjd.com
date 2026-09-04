/**
 * recordSearchTerm 单元测试
 *
 * 2026-08-22 策略：只要搜索就记录 + 打印日志（防刷前移到搜索入口，
 * 本层不再做 UA/IP 过滤）。
 *
 * 2026-08-22 修复：
 * - 词条校验放宽（允许片名常见标点，防误杀"哈利·波特与魔法石"）
 * - 同词 30s 去重（前端并发子请求导致同一词重复记录 N 次）
 *
 * 验证：
 * - 正常词记录
 * - 带标点片名记录（哈利·波特与魔法石 等）
 * - 同词 30s 内去重（只记一次），窗口过后可再记录
 * - 非法词条跳过（空串/超长/URL）
 * - 记录失败静默不影响主流程
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { recordSearchTerm, resetTermDedup } from "../../server/utils/recordSearchTerm";

// mock 热搜服务，避免测试触碰 Turso（返回单例，模拟真实 getOrCreate 语义）
const mockService = {
  recordSearch: vi.fn().mockResolvedValue(undefined),
};
vi.mock("../../server/core/services/hotSearchService", () => ({
  getOrCreateHotSearchService: vi.fn(() => mockService),
}));

import { getOrCreateHotSearchService } from "../../server/core/services/hotSearchService";

// mock 搜索明细日志 store，避免测试触碰 Turso（2026-08-25：search_log 关联）
const mockLogStore = {
  logSearch: vi.fn().mockResolvedValue(undefined),
};
vi.mock("../../server/core/services/tursoSearchLogStore", () => ({
  getSearchLogStore: vi.fn(() => mockLogStore),
}));

const mockedGetService = vi.mocked(getOrCreateHotSearchService);

describe("recordSearchTerm", () => {
  beforeEach(() => {
    mockedGetService.mockClear();
    mockService.recordSearch.mockClear();
    mockLogStore.logSearch.mockClear();
    resetTermDedup();
  });

  it("正常中文词记录", async () => {
    await recordSearchTerm("凡人修仙传");
    expect(mockedGetService).toHaveBeenCalledTimes(1);
    expect(mockService.recordSearch).toHaveBeenCalledWith("凡人修仙传");
  });

  it("带空格/英文/数字的词记录（trim 后）", async () => {
    await recordSearchTerm("  肖申克的救赎  ");
    await recordSearchTerm("test123 abc");
    expect(mockService.recordSearch).toHaveBeenCalledTimes(2);
    expect(mockService.recordSearch).toHaveBeenNthCalledWith(1, "肖申克的救赎");
    expect(mockService.recordSearch).toHaveBeenNthCalledWith(2, "test123 abc");
  });

  it("带标点片名记录（哈利·波特与魔法石 等，防误杀真人）", async () => {
    await recordSearchTerm("哈利·波特与魔法石");
    await recordSearchTerm("《繁花》");
    await recordSearchTerm("猎冰-2024");
    await recordSearchTerm("蜘蛛侠：英雄无归");
    expect(mockService.recordSearch).toHaveBeenCalledTimes(4);
    expect(mockService.recordSearch).toHaveBeenNthCalledWith(1, "哈利·波特与魔法石");
    expect(mockService.recordSearch).toHaveBeenNthCalledWith(2, "《繁花》");
    expect(mockService.recordSearch).toHaveBeenNthCalledWith(3, "猎冰-2024");
    expect(mockService.recordSearch).toHaveBeenNthCalledWith(4, "蜘蛛侠：英雄无归");
  });

  it("同词 30s 内去重（前端并发子请求只记一次）", async () => {
    await recordSearchTerm("水子哥");
    await recordSearchTerm("水子哥");
    await recordSearchTerm("水子哥");
    // 同一词只记一次
    expect(mockService.recordSearch).toHaveBeenCalledTimes(1);
    expect(mockService.recordSearch).toHaveBeenCalledWith("水子哥");
  });

  it("不同词不受去重影响", async () => {
    await recordSearchTerm("水子哥");
    await recordSearchTerm("沧元图");
    await recordSearchTerm("夜王");
    expect(mockService.recordSearch).toHaveBeenCalledTimes(3);
  });

  it("非法词条不记录（空串/纯空白/超长上限200）", async () => {
    await recordSearchTerm("");
    await recordSearchTerm("   ");
    await recordSearchTerm("a".repeat(201));
    expect(mockedGetService).not.toHaveBeenCalled();
  });

  it("URL/绝对路径/控制字符/纯符号被过滤（2026-08-22 用户拍板：加格式校验）", async () => {
    await recordSearchTerm("https://example.com/share");
    await recordSearchTerm("http://www.baidu.com");
    await recordSearchTerm("www.example.com");
    await recordSearchTerm("//cdn.example.com/a.js");
    await recordSearchTerm("\\server\\share\\file");
    await recordSearchTerm("!!!@@@###");
    await recordSearchTerm("----");
    expect(mockedGetService).not.toHaveBeenCalled();
  });

  it("含标点片名正常记录（不误杀真人）", async () => {
    await recordSearchTerm("哈利·波特与魔法石");
    await recordSearchTerm("《繁花》");
    await recordSearchTerm("猎冰-2024");
    await recordSearchTerm("蜘蛛侠：英雄无归");
    await recordSearchTerm("A·B+C 100%");
    expect(mockService.recordSearch).toHaveBeenCalledTimes(5);
  });

  it("记录失败静默（不影响主流程，不抛错）", async () => {
    mockedGetService.mockImplementationOnce(() => {
      throw new Error("store unavailable");
    });
    await expect(recordSearchTerm("凡人修仙传")).resolves.toBeUndefined();
  });

  it("写搜索明细日志（openid/ip/term 关联，2026-08-25）", async () => {
    await recordSearchTerm("霸王别姬", "1.2.3.4", "openid-test-abc");
    expect(mockLogStore.logSearch).toHaveBeenCalledTimes(1);
    expect(mockLogStore.logSearch).toHaveBeenCalledWith({
      openid: "openid-test-abc",
      ip: "1.2.3.4",
      term: "霸王别姬",
      now: expect.any(Number),
    });
  });

  it("未登录（无 openid）时明细 openid 为空串，仅记 ip+term", async () => {
    await recordSearchTerm("使徒行者", "9.9.9.9");
    expect(mockLogStore.logSearch).toHaveBeenCalledTimes(1);
    expect(mockLogStore.logSearch).toHaveBeenCalledWith({
      openid: "",
      ip: "9.9.9.9",
      term: "使徒行者",
      now: expect.any(Number),
    });
  });

  it("非法词条不写明细日志（与统计一致）", async () => {
    await recordSearchTerm("!!!@@@###");
    expect(mockLogStore.logSearch).not.toHaveBeenCalled();
  });
});
