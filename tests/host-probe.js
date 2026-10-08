'use strict';

/**
 * 实测「应用的域名」在国内能否打开（控制台能开不代表应用域名能开）。
 *   node tests/host-probe.js
 *
 * 结论用来决定：这套代码最终部署到哪里，同学才能真的打开。
 */

const targets = [
  // 已确认被阻断的对照
  { name: 'Vercel 应用 *.vercel.app', url: 'https://homework-site-304-7422.vercel.app/' },

  // 免费平台的应用域名（探测根域名/示例站点即可判断该后缀是否可达）
  { name: 'Deno Deploy *.deno.dev', url: 'https://dash.deno.com/' },
  { name: 'Val Town *.val.run', url: 'https://www.val.town/' },
  { name: 'Cloudflare *.workers.dev', url: 'https://workers.cloudflare.com/' },
  { name: 'Cloudflare *.pages.dev', url: 'https://pages.dev/' },
  { name: 'Zeabur *.zeabur.app', url: 'https://zeabur.com/' },
  { name: 'Glitch *.glitch.me', url: 'https://glitch.com/' },
  { name: 'Replit *.replit.app', url: 'https://replit.com/' },
  { name: 'PythonAnywhere', url: 'https://www.pythonanywhere.com/' },
  { name: 'Koyeb *.koyeb.app', url: 'https://www.koyeb.app/' },
  { name: 'Cyclic / Deta 类', url: 'https://deta.space/' },

  // 国内免费/低价平台
  { name: 'Gitee Pages *.gitee.io', url: 'https://gitee.com/' },
  { name: '腾讯云 EdgeOne Pages', url: 'https://edgeone.ai/' },
  { name: '阿里云 ESA', url: 'https://esa.console.aliyun.com/' },
  { name: '腾讯云 CloudBase', url: 'https://tcb.cloud.tencent.com/' },

  // 内网穿透（临时方案）
  { name: 'cpolar *.cpolar.cn', url: 'https://www.cpolar.com/' },
  { name: '花生壳 *.iask.in', url: 'https://hsk.oray.com/' },
  { name: 'ngrok *.ngrok-free.app', url: 'https://ngrok.com/' },
  { name: 'frp 官方文档', url: 'https://gofrp.org/' },

  // 免费数据库（国内可达性）
  { name: 'Supabase', url: 'https://supabase.com/' },
  { name: 'Upstash', url: 'https://console.upstash.com/' },
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
  console.log('\n候选平台可达性实测（国内网络）…\n');
  const results = [];
  for (const target of targets) {
    const result = await probe(target);
    results.push({ target, result });
    const label = target.name.padEnd(30, ' ');
    if (result.ok) console.log(`  ✅ ${label} HTTP ${String(result.status).padEnd(4)} (${result.ms}ms)`);
    else console.log(`  ❌ ${label} ${result.error}`);
  }
  const reachable = results.filter((r) => r.result.ok).length;
  console.log(`\n可达 ${reachable}/${results.length}\n`);
})();
