/**
 * 作业云服务器 · Deno Deploy 入口
 *
 *  本机运行：  deno run -A server.ts         → http://localhost:8000
 *  线上部署：  Deno Deploy 新建 project，Entrypoint 填 server.ts
 *
 * 路由：
 *   GET  /api/health            自检（数据库、密钥）
 *   GET  /api/auth?action=...   站点状态 / 当前会话
 *   POST /api/auth              初始化、登录、改口令
 *   GET  /api/data              读取全部数据（需登录）
 *   PUT  /api/data              保存（乐观锁 + 冲突合并）
 *   其它路径                     静态页面（index.html / styles.css / js/*.js）
 */

import { healthRoute, authRoute, dataRoute } from './src/api.ts';
import { getStore } from './src/store.ts';
import { ensureStatic, lookupStatic } from './src/static-runtime.ts';
import { fail } from './src/util.ts';

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'SAMEORIGIN',
};

function staticResponse(pathname: string): Response | null {
  const file = lookupStatic(pathname);
  if (!file) return null;
  const isHtml = file.type.startsWith('text/html');
  return new Response(file.body, {
    status: 200,
    headers: {
      'content-type': file.type,
      // HTML 不缓存（保证拿到最新页面），JS/CSS 短缓存
      'cache-control': isHtml ? 'no-cache' : 'public, max-age=300',
      ...SECURITY_HEADERS,
    },
  });
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;

  // 接口
  if (pathname === '/api/health') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail('不支持的请求方法', 405);
    const store = await getStore();
    return await healthRoute(store);
  }

  if (pathname === '/api/auth') {
    if (!['GET', 'POST', 'HEAD'].includes(req.method)) return fail('不支持的请求方法', 405);
    const store = await getStore();
    return await authRoute(req, store, url);
  }

  if (pathname === '/api/data') {
    if (!['GET', 'PUT', 'HEAD'].includes(req.method)) return fail('不支持的请求方法', 405);
    const store = await getStore();
    return await dataRoute(req, store, url);
  }

  if (pathname.startsWith('/api/')) return fail('接口不存在', 404);

  // 静态资源（第一次请求时把清单准备好）
  await ensureStatic();
  const asset = staticResponse(pathname);
  if (asset) return asset;

  // 其它路径一律回到首页（单页应用的习惯做法）
  const fallback = staticResponse('/');
  if (fallback) {
    return new Response(fallback.body, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', ...SECURITY_HEADERS },
    });
  }
  return fail('页面不存在', 404);
}

const port = Number(Deno.env.get('PORT') ?? 8000);

if (import.meta.main) {
  console.log(`\n  作业云服务器 · Deno 版已启动`);
  console.log(`  网页地址   http://localhost:${port}`);
  console.log(`  自检接口   http://localhost:${port}/api/health`);
  console.log(`  数据存储   ${await (await getStore()).health().then((h) => h.detail ?? h.store).catch(() => '未知')}`);
  console.log(`\n  按 Ctrl+C 停止\n`);
}

Deno.serve({ port, hostname: '0.0.0.0' }, handler);
