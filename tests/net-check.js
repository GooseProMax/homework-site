'use strict';

/**
 * 网络体检：确认这台机器能不能连上 GitHub / Vercel / npm 等部署要用的服务。
 * 用 Node 的原生 fetch（TLS 版本比 PowerShell 5.1 的 Invoke-WebRequest 新，结果更能代表浏览器和 git）。
 *   node tests/net-check.js
 */

const targets = [
  { name: 'GitHub 网页', url: 'https://github.com', probe: 'https://github.com/login' },
  { name: 'GitHub API', url: 'https://api.github.com/zen' },
  { name: 'GitHub 代码上传（HTTPS）', url: 'https://github.com/your-name/homework-site.git/info/refs?service=git-upload-pack' },
  { name: 'Vercel 控制台', url: 'https://vercel.com' },
  { name: 'Vercel API', url: 'https://api.vercel.com/v2/teams' },
  { name: 'npm 源', url: 'https://registry.npmjs.org/-/ping' },
  { name: 'Upstash 官网', url: 'https://upstash.com' },
  { name: 'Neon 官网', url: 'https://neon.tech' },
];

async function probe(target) {
  const started = Date.now();
  try {
    const response = await fetch(target.probe || target.url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(12000),
    });
    return { ok: true, status: response.status, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: `${err.name}: ${err.message}`, ms: Date.now() - started };
  }
}

(async () => {
  console.log('\n网络连通性检查…\n');
  const results = await Promise.all(targets.map(async (target) => ({ target, result: await probe(target) })));
  let reachable = 0;
  results.forEach(({ target, result }) => {
    if (result.ok) {
      reachable += 1;
      console.log(`  ✅ ${target.name.padEnd(24, ' ')} HTTP ${result.status}  (${result.ms}ms)`);
    } else {
      console.log(`  ❌ ${target.name.padEnd(24, ' ')} ${result.error}`);
    }
  });
  console.log(`\n${reachable}/${targets.length} 个目标可达。`);
  if (reachable === 0) {
    console.log('⚠️  完全连不上外网：这台机器可能被防火墙/代理挡住了，需要在能上网的电脑上完成部署步骤。');
  } else if (reachable < targets.length) {
    console.log('ℹ️  部分目标不通：通常不影响部署，只影响某些可选方案。');
  }
  console.log('');
})();
