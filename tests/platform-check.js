'use strict';

/**
 * 在国内网络环境实测：哪些免费托管平台的域名能连上。
 *   node tests/platform-check.js
 *
 * vercel.app 已被实测阻断（ECONNRESET），这里把常见替代平台一次测完，
 * 结果用来选「真正能发给同学打开」的部署方案。
 */

const targets = [
  { name: 'Vercel (对照，已知被阻断)', url: 'https://homework-site-304-7422.vercel.app/api/health' },
  { name: 'Vercel 主站 (可访问)', url: 'https://vercel.com' },
  { name: 'Cloudflare Pages', url: 'https://cloudflare-pages.pages.dev' },
  { name: 'Cloudflare 主站', url: 'https://dash.cloudflare.com/login' },
  { name: 'Netlify', url: 'https://app.netlify.com' },
  { name: 'Deno Deploy', url: 'https://dash.deno.com' },
  { name: 'Val Town', url: 'https://www.val.town' },
  { name: 'Render', url: 'https://render.com' },
  { name: 'Railway', url: 'https://railway.app' },
  { name: 'Fly.io', url: 'https://fly.io' },
  { name: 'Gitee Pages 主站', url: 'https://gitee.com' },
  { name: '腾讯云 EdgeOne', url: 'https://edgeone.ai' },
  { name: '阿里云 ESA', url: 'https://esa.console.aliyun.com' },
  { name: 'Supabase (数据库备选)', url: 'https://supabase.com' },
  { name: 'Upstash 控制台', url: 'https://console.upstash.com' },
];

async function probe(target) {
  const started = Date.now();
  try {
    const response = await fetch(target.url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(12000),
    });
    return { ok: true, status: response.status, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: (err.cause && err.cause.message) || err.message, ms: Date.now() - started };
  }
}

(async () => {
  console.log('\n国内网络连通性实测（决定用哪个平台部署）…\n');
  for (const target of targets) {
    const result = await probe(target);
    const label = target.name.padEnd(28, ' ');
    if (result.ok) console.log(`  ✅ ${label} HTTP ${result.status}  (${result.ms}ms)`);
    else console.log(`  ❌ ${label} ${result.error}`);
  }
  console.log('');
})();
