import { describe, it, expect } from "vitest";
import {
  classifyAliyun,
  classifyQuarkToken,
  classifyQuarkDetail,
  classifyUCPage,
  classifyBaiduVerify,
  classifyBaiduList,
  classifyTianyi,
  classify123,
  classifyXunlei,
  classify115,
  classifyMobile,
  detectPlatform,
  extractAliyunShareID,
  extractQuarkShareIDAndPassword,
  extractBaiduShareInfo,
  extractTianyiShareInfo,
  extract123ShareKey,
  extractXunleiShareInfo,
  extract115ShareInfo,
  extractMobileShareID,
  normalizeShareLink,
  buildXunleiCaptchaSignature,
  encryptMobilePayload,
  decryptMobilePayload,
  checkLink,
  _clearLinkCheckCache,
  _resetCircuits,
  isCircuitOpen,
  recordCircuitFailure,
  recordCircuitSuccess,
} from "../../server/core/services/linkChecker";

describe("linkChecker / classifyAliyun（pansou 逻辑）", () => {
  it("code 含 sharelink / notfound / expired => bad", () => {
    expect(classifyAliyun({ code: "ShareLinkNotExist" }, 200).status).toBe("bad");
    expect(classifyAliyun({ code: "NotFound" }, 200).status).toBe("bad");
    expect(classifyAliyun({ code: "ShareLinkExpired" }, 200).status).toBe("bad");
  });

  it("code 含 exceed/frequency/limit => uncertain（限流不是失效）", () => {
    expect(classifyAliyun({ code: "TooManyRequests", message: "exceed" }, 200).status).toBe("uncertain");
  });

  it("file_count=0 且无名称 => bad", () => {
    expect(classifyAliyun({ file_count: 0, share_name: "" }, 200).status).toBe("bad");
  });

  it("share_status 异常 => bad", () => {
    expect(classifyAliyun({ share_status: "forbidden" }, 200).status).toBe("bad");
  });

  it("200 且有 share_name/file_count>0 => ok", () => {
    expect(classifyAliyun({ share_name: "x", file_count: 3 }, 200).status).toBe("ok");
    expect(classifyAliyun({ share_title: "t" }, 200).status).toBe("ok");
  });
});

describe("linkChecker / classifyQuark（pansou 逻辑）", () => {
  it("code 41008 => locked", () => {
    expect(classifyQuarkToken({ code: 41008, message: "需要提取码" }).status).toBe("locked");
  });

  it("code 41004/41010/41011 => bad", () => {
    expect(classifyQuarkToken({ code: 41004 }).status).toBe("bad");
    expect(classifyQuarkToken({ code: 41010 }).status).toBe("bad");
    expect(classifyQuarkToken({ code: 41011 }).status).toBe("bad");
  });

  it("message 含 不存在/失效 => bad", () => {
    expect(classifyQuarkToken({ code: 999, message: "分享链接不存在" }).status).toBe("bad");
  });

  it("message 含 提取码 => locked", () => {
    expect(classifyQuarkToken({ code: 999, message: "请提供提取码" }).status).toBe("locked");
  });

  it("code 0 + stoken => ok 并带出 stoken", () => {
    const r = classifyQuarkToken({ code: 0, data: { stoken: "tok" } });
    expect(r.status).toBe("ok");
    expect(r.stoken).toBe("tok");
  });

  it("code 0 无 stoken => uncertain", () => {
    expect(classifyQuarkToken({ code: 0, data: {} }).status).toBe("uncertain");
  });

  it("detail：list 为空且 status>1 => bad", () => {
    expect(classifyQuarkDetail({ data: { list: [], share: { status: 3 } } }).status).toBe("bad");
  });

  it("detail：list 为空且 is_expire => bad", () => {
    expect(classifyQuarkDetail({ data: { list: [], share: {}, is_expire: true } }).status).toBe("bad");
  });

  it("detail：list 非空且 status 1 => ok", () => {
    expect(classifyQuarkDetail({ data: { list: [{}], share: { status: 1 } } }).status).toBe("ok");
  });

  it("detail：status 3 + partial_violation => bad", () => {
    expect(
      classifyQuarkDetail({ data: { list: [{}], share: { status: 3, partial_violation: true } } }).status
    ).toBe("bad");
  });
});

describe("linkChecker / classifyUCPage", () => {
  it("404 => bad", () => {
    expect(classifyUCPage("not found", 404).status).toBe("bad");
  });

  it("页面含 已失效/不存在 => bad", () => {
    expect(classifyUCPage("该链接已失效", 200).status).toBe("bad");
    expect(classifyUCPage("文件不存在", 200).status).toBe("bad");
  });

  it("页面含 提取码 => locked", () => {
    expect(classifyUCPage("请输入提取码", 200).status).toBe("locked");
  });

  it("页面含 文件/分享 => ok", () => {
    expect(classifyUCPage("我的分享文件夹", 200).status).toBe("ok");
  });

  it("无关页面 => uncertain", () => {
    expect(classifyUCPage("<html>hello</html>", 200).status).toBe("uncertain");
  });
});

describe("linkChecker / classifyBaidu", () => {
  it("verify errno 0 => ok + bdclnd", () => {
    const r = classifyBaiduVerify({ errno: 0, randsk: "abc" });
    expect(r.status).toBe("ok");
    expect(r.bdclnd).toBe("abc");
  });

  it("verify errno -9/-12 => locked", () => {
    expect(classifyBaiduVerify({ errno: -9 }).status).toBe("locked");
  });

  it("list errno 0 + list 非空 => ok", () => {
    expect(classifyBaiduList({ errno: 0, list: [{ fs_id: 1 }] }).status).toBe("ok");
  });

  it("list errno 0 + list 空 => bad", () => {
    expect(classifyBaiduList({ errno: 0, list: [] }).status).toBe("bad");
  });

  it("list errno -9/-12 => locked；-7/105/115/117/145 => bad", () => {
    expect(classifyBaiduList({ errno: -12 }).status).toBe("locked");
    expect(classifyBaiduList({ errno: -7 }).status).toBe("bad");
    expect(classifyBaiduList({ errno: 105 }).status).toBe("bad");
  });
});

describe("linkChecker / classifyTianyi（XML/错误码扫描）", () => {
  it("shareVO + shareId>0 => ok", () => {
    const xml = '<?xml version="1.0"?><shareVO><shareId>12345</shareId><fileName>a.mp4</fileName></shareVO>';
    expect(classifyTianyi(xml, 200).status).toBe("ok");
  });

  it("needAccessCode=1 => ok（需访问码说明存在）", () => {
    const xml = '<shareVO><needAccessCode>1</needAccessCode></shareVO>';
    expect(classifyTianyi(xml, 200).status).toBe("ok");
  });

  it("已知错误码 => bad 且映射为中文", () => {
    const r = classifyTianyi('<error><code>ShareExpiredError</code></error>', 200);
    expect(r.status).toBe("bad");
    expect(r.reason).toBe("分享链接已过期");
  });

  it("含 访问码/提取码 => locked", () => {
    expect(classifyTianyi("needAccessCode 需要访问码", 200).status).toBe("locked");
  });

  it("含 不存在/失效 => bad", () => {
    expect(classifyTianyi("分享链接不存在", 200).status).toBe("bad");
  });
});

describe("linkChecker / classify123", () => {
  it("403 => ok（防爬反而证明存在）", () => {
    expect(classify123(null, 403).status).toBe("ok");
  });

  it("code 0 => ok", () => {
    expect(classify123({ code: 0 }, 200).status).toBe("ok");
  });

  it("HasPwd => locked", () => {
    expect(classify123({ code: 0, data: { HasPwd: true } }, 200).status).toBe("locked");
  });

  it("message => bad", () => {
    expect(classify123({ code: 1, message: "share not found" }, 200).status).toBe("bad");
  });
});

describe("linkChecker / classifyXunlei", () => {
  it("share_status OK => ok", () => {
    expect(classifyXunlei({ share_status: "OK" }).status).toBe("ok");
  });

  it("有 share_id/share_name/file_count => ok", () => {
    expect(classifyXunlei({ share_id: "s1" }).status).toBe("ok");
    expect(classifyXunlei({ file_count: 2 }).status).toBe("ok");
  });

  it("error 含 pass_code => locked", () => {
    expect(classifyXunlei({ error: "pass_code required" }).status).toBe("locked");
  });

  it("share_status 非 OK => bad", () => {
    expect(classifyXunlei({ share_status: "NOT_FOUND" }).status).toBe("bad");
  });

  it("error 含 not found => bad", () => {
    expect(classifyXunlei({ error: "share not found" }).status).toBe("bad");
  });
});

describe("linkChecker / classify115", () => {
  it("state+errno 0 + list 非空 => ok", () => {
    expect(classify115({ state: true, errno: 0, data: { list: [{}] } }).status).toBe("ok");
  });

  it("share_state 1 => ok", () => {
    expect(classify115({ state: true, errno: 0, data: { share_state: 1 } }).status).toBe("ok");
  });

  it("forbid_reason 含 密码 => locked", () => {
    expect(
      classify115({ state: true, errno: 0, data: { share_state: 2, shareinfo: { forbid_reason: "需要密码" } } }).status
    ).toBe("locked");
  });

  it("share_state 2 但 forbid_reason 为空 => locked（不漏判为失效）", () => {
    expect(classify115({ state: true, errno: 0, data: { share_state: 2, shareinfo: {} } }).status).toBe("locked");
  });

  it("error 含 不存在 => bad", () => {
    expect(classify115({ state: false, error: "分享不存在或已被删除" }).status).toBe("bad");
  });
});

describe("linkChecker / classifyMobile", () => {
  it("resultCode 0 + data => ok", () => {
    expect(classifyMobile(JSON.stringify({ resultCode: "0", data: { list: [] } })).status).toBe("ok");
  });

  it("desc 含 提取码 => locked", () => {
    expect(classifyMobile(JSON.stringify({ desc: "需要提取码" })).status).toBe("locked");
  });

  it("desc 含 失效 => bad", () => {
    expect(classifyMobile(JSON.stringify({ desc: "分享已失效" })).status).toBe("bad");
  });
});

describe("linkChecker / share id 提取（pansou extract*）", () => {
  it("aliyun：path 最后一段", () => {
    expect(extractAliyunShareID("https://www.alipan.com/s/abc123")).toBe("abc123");
  });

  it("quark：id + pwd", () => {
    const r = extractQuarkShareIDAndPassword("https://pan.quark.cn/s/abc123?pwd=8888");
    expect(r.id).toBe("abc123");
    expect(r.password).toBe("8888");
  });

  it("baidu：/s/1xxx 去前缀 1 + surl + pwd", () => {
    const r = extractBaiduShareInfo("https://pan.baidu.com/s/1AbCdE?pwd=8888");
    expect(r.shareID).toBe("1AbCdE");
    expect(r.shortURL).toBe("AbCdE");
    expect(r.password).toBe("8888");
    const r2 = extractBaiduShareInfo("https://pan.baidu.com/share/init?surl=XyZ");
    expect(r2.shortURL).toBe("XyZ");
  });

  it("tianyi：code + 访问码", () => {
    const r = extractTianyiShareInfo("https://cloud.189.cn/t/abc123（访问码：1234）");
    expect(r.shareCode).toBe("abc123");
    expect(r.password).toBe("1234");
  });

  it("123 / xunlei / 115 / mobile", () => {
    expect(extract123ShareKey("https://www.123pan.com/s/kkk123")).toBe("kkk123");
    const x = extractXunleiShareInfo("https://pan.xunlei.com/s/XL01?pwd=ab12");
    expect(x.id).toBe("XL01");
    expect(x.password).toBe("ab12");
    const s = extract115ShareInfo("https://115.com/s/115abc?password=pw9");
    expect(s.shareCode).toBe("115abc");
    expect(s.password).toBe("pw9");
    expect(extractMobileShareID("https://caiyun.139.com/w/i/139link")).toBe("139link");
  });
});

describe("linkChecker / normalizeShareLink", () => {
  it("baidu 注入 pwd、去 fragment", () => {
    const n = normalizeShareLink("baidu", "https://pan.baidu.com/s/1Xyz#frag", "8888");
    expect(n).toContain("pwd=8888");
    expect(n).not.toContain("#frag");
  });

  it("无密码不改 URL", () => {
    const n = normalizeShareLink("aliyun", "https://www.alipan.com/s/abc", undefined);
    expect(n).toBe("https://www.alipan.com/s/abc");
  });
});

describe("linkChecker / detectPlatform", () => {
  it("识别各平台", () => {
    expect(detectPlatform("https://www.alipan.com/s/x")).toBe("aliyun");
    expect(detectPlatform("https://pan.quark.cn/s/x")).toBe("quark");
    expect(detectPlatform("https://drive.uc.cn/s/x")).toBe("uc");
    expect(detectPlatform("https://pan.baidu.com/s/1x")).toBe("baidu");
    expect(detectPlatform("https://cloud.189.cn/t/x")).toBe("tianyi");
    expect(detectPlatform("https://www.123pan.com/s/x")).toBe("123");
    expect(detectPlatform("https://pan.xunlei.com/s/x")).toBe("xunlei");
    expect(detectPlatform("https://115.com/s/x")).toBe("115");
    expect(detectPlatform("https://caiyun.139.com/w/i/x")).toBe("mobile");
  });

  it("magnet / ed2k / 普通链接 => others", () => {
    expect(detectPlatform("magnet:?xt=urn:btih:abcdef")).toBe("others");
    expect(detectPlatform("ed2k://|file|a.avi|1|hash|/")).toBe("others");
    expect(detectPlatform("https://example.com/foo")).toBe("others");
  });
});

describe("linkChecker / xunlei captcha 签名 + mobile AES", () => {
  it("签名格式 1.<hex>，timestamp 为毫秒数", () => {
    const { timestamp, signature } = buildXunleiCaptchaSignature("a", "b", "c", "d");
    expect(timestamp).toMatch(/^\d+$/);
    expect(signature).toMatch(/^1\.[0-9a-f]{32}$/);
  });

  it("AES 加解密往返一致", () => {
    const payload = { getOutLinkInfoReq: { linkID: "x", passwd: "8888" } };
    const enc = encryptMobilePayload(payload);
    const dec = decryptMobilePayload(enc);
    expect(JSON.parse(dec)).toEqual(payload);
  });
});

describe("linkChecker / checkLink 无网络路径", () => {
  it("磁力链接直接 unsupported", async () => {
    _clearLinkCheckCache();
    const r = await checkLink({ url: "magnet:?xt=urn:btih:abcdef0123" });
    expect(r.status).toBe("unsupported");
    expect(r.platform).toBe("others");
  });

  it("普通非网盘链接 => unsupported", async () => {
    _clearLinkCheckCache();
    const r = await checkLink({ url: "https://example.com/foo" });
    expect(r.status).toBe("unsupported");
  });
});

describe("linkChecker / 平台熔断", () => {
  it("连续 3 次网络失败后熔断开启", () => {
    _resetCircuits();
    expect(isCircuitOpen("quark")).toBe(false);
    recordCircuitFailure("quark");
    recordCircuitFailure("quark");
    expect(isCircuitOpen("quark")).toBe(false); // 2 次未熔断
    recordCircuitFailure("quark");
    expect(isCircuitOpen("quark")).toBe(true); // 3 次熔断
    _resetCircuits();
  });

  it("成功一次即清除熔断", () => {
    _resetCircuits();
    recordCircuitFailure("quark");
    recordCircuitFailure("quark");
    recordCircuitFailure("quark");
    expect(isCircuitOpen("quark")).toBe(true);
    recordCircuitSuccess("quark");
    expect(isCircuitOpen("quark")).toBe(false);
    _resetCircuits();
  });

  it("熔断中的链接直接返回 uncertain 且不发网络（快速）", async () => {
    _resetCircuits();
    _clearLinkCheckCache();
    // 熔断 quark
    recordCircuitFailure("quark");
    recordCircuitFailure("quark");
    recordCircuitFailure("quark");
    const start = Date.now();
    const r = await checkLink({ url: "https://pan.quark.cn/s/abcdef1234" });
    expect(r.status).toBe("uncertain");
    expect(r.reason).toContain("熔断");
    expect(Date.now() - start).toBeLessThan(500); // 无网络请求
    _resetCircuits();
  });
});
