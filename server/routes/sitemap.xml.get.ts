import { defineEventHandler } from "h3";
import { getOrCreateHotSearchService } from "../core/services/hotSearchService";

/**
 * 动态 sitemap.xml：只收录高价值搜索词（用户真实重复搜索过的词）
 * URL 采用首页 query 形式 /?q=xxx（复用首页搜索体验），避免生成无限 /s/ 页面，
 * 防止被搜索引擎判定为门页农场，同时把收录权重集中到首页
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig();
  const siteUrl = ((config.public?.siteUrl as string) || "").replace(/\/$/, "");
  const service = getOrCreateHotSearchService();
  const terms = await service.getTopTerms(1000);

  const urls = terms
    .map((t) => {
      const loc = `${siteUrl}/?q=${encodeURIComponent(t.term)}`;
      return `  <url>\n    <loc>${loc}</loc>\n    <changefreq>weekly</changefreq>\n  </url>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

  event.node.res.setHeader("Content-Type", "application/xml; charset=utf-8");
  event.node.res.setHeader("Cache-Control", "public, max-age=3600");
  return xml;
});
