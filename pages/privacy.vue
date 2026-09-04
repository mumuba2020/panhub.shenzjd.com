<script setup lang="ts">
// 隐私政策页（2026-08-25 新增）：声明搜索历史记录与用途，合规要求
useSeoMeta({
  title: "隐私政策 - PanHub 网盘搜索",
  description: "PanHub 隐私政策：说明搜索词、搜索历史等数据的收集与使用方式。",
  robots: "index,follow",
});
</script>

<template>
  <div class="privacy-page">
    <div class="privacy-card">
      <h1>隐私政策</h1>
      <p class="updated">更新日期：2026-08-25</p>

      <section>
        <h2>一、我们收集的信息</h2>
        <ul>
          <li>
            <strong>搜索词</strong>：你输入的关键词，用于生成热搜榜单、词云与搜索日历，
            并帮助其他用户发现热门资源。
          </li>
          <li>
            <strong>搜索历史</strong>：为保障服务安全与排查问题，我们可能记录每次搜索的
            关键词、微信身份标识（openid）、IP 地址与时间。该记录用于安全防护（如识别
            恶意刷词）、问题排查与滥用防范。
          </li>
          <li>
            <strong>设备与访问信息</strong>：服务端日志可能包含浏览器标识（UA）、请求路径
            与时间，用于限流、反爬与故障定位。
          </li>
        </ul>
      </section>

      <section>
        <h2>二、信息的使用</h2>
        <ul>
          <li>提供搜索服务并优化结果相关性；</li>
          <li>生成热搜/词云/日历等聚合展示（聚合后不包含个人身份信息）；</li>
          <li>安全防护：识别并拦截恶意刷词、爬虫与滥用行为；</li>
          <li>问题排查与服务质量改进。</li>
        </ul>
      </section>

      <section>
        <h2>三、信息的存储与保留</h2>
        <p>
          搜索历史等明细数据长期保留用于安全排查，我们会在技术可行时提供定期清理机制。
          聚合统计数据（热搜/词云）不包含可识别个人的信息。
        </p>
      </section>

      <section>
        <h2>四、信息的共享</h2>
        <p>
          我们不会向第三方出售或提供你的个人搜索记录。仅在法律要求或为保护本站
          合法权益（如应对滥用）时，可能依法披露。
        </p>
      </section>

      <section>
        <h2>五、你的权利</h2>
        <p>
          你可以通过本站公布的渠道（Telegram / GitHub）联系我们，要求查询或删除与
          你相关的搜索记录。
        </p>
      </section>

      <section>
        <h2>六、联系我们</h2>
        <p>
          如有隐私相关问题，可通过
          <a href="https://t.me/shenzjd_com" target="_blank" rel="noopener noreferrer">Telegram</a>
          或
          <a href="https://github.com/wu529778790/panhub.shenzjd.com" target="_blank" rel="noopener noreferrer">GitHub</a>
          与我们联系。
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.privacy-page {
  max-width: 760px;
  margin: 0 auto;
  padding: 32px 20px 64px;
  color: var(--text-color, #1f2937);
}
.privacy-card {
  background: var(--card-bg, #fff);
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 12px;
  padding: 28px 32px;
  line-height: 1.8;
}
.privacy-card h1 {
  font-size: 24px;
  margin: 0 0 4px;
}
.privacy-card .updated {
  color: var(--muted-color, #6b7280);
  font-size: 13px;
  margin-bottom: 20px;
}
.privacy-card h2 {
  font-size: 17px;
  margin: 20px 0 8px;
}
.privacy-card ul {
  padding-left: 20px;
  margin: 8px 0;
}
.privacy-card li {
  margin: 4px 0;
}
.privacy-card a {
  color: var(--accent-color, #2563eb);
}
</style>
