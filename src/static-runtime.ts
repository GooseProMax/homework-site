/**
 * 静态资源清单：优先用 src/static.ts（deno task sync 或构建时生成），
 * 万一没生成（本机刚 clone、或构建命令没跑），就退回到直接读磁盘文件。
 *
 * 注意：这里故意用「动态 import + try/catch」，因为把 import 静态写在顶层的话，
 * 生成文件不存在时整个 server.ts 都会加载失败。
 */

export interface StaticFile {
  body: string;
  type: string;
}

const CANDIDATES: { url: string; file: string; type: string }[] = [
  { url: '/', file: 'index.html', type: 'text/html; charset=utf-8' },
  { url: '/index.html', file: 'index.html', type: 'text/html; charset=utf-8' },
  { url: '/styles.css', file: 'styles.css', type: 'text/css; charset=utf-8' },
  { url: '/js/util.js', file: 'js/util.js', type: 'text/javascript; charset=utf-8' },
  { url: '/js/api.js', file: 'js/api.js', type: 'text/javascript; charset=utf-8' },
  { url: '/js/store.js', file: 'js/store.js', type: 'text/javascript; charset=utf-8' },
  { url: '/js/render.js', file: 'js/render.js', type: 'text/javascript; charset=utf-8' },
  { url: '/js/modals.js', file: 'js/modals.js', type: 'text/javascript; charset=utf-8' },
  { url: '/js/app.js', file: 'js/app.js', type: 'text/javascript; charset=utf-8' },
];

let cache: Record<string, StaticFile> | null = null;

async function loadFromDisk(): Promise<Record<string, StaticFile>> {
  const result: Record<string, StaticFile> = {};
  for (const item of CANDIDATES) {
    try {
      const body = await Deno.readTextFile(new URL(`../${item.file}`, import.meta.url));
      result[item.url] = { body, type: item.type };
    } catch (err) {
      console.error(`[static] 读不到 ${item.file}：${(err as Error).message}`);
    }
  }
  return result;
}

/** 第一次请求时把静态资源准备好 */
export async function ensureStatic(): Promise<Record<string, StaticFile>> {
  if (cache) return cache;
  try {
    const generated = await import('./static.ts');
    if (generated && generated.STATIC_FILES) {
      cache = generated.STATIC_FILES as Record<string, StaticFile>;
      return cache;
    }
  } catch {
    console.warn('[static] 没有生成 src/static.ts，改为直接读文件（本机开发正常，线上请配置构建命令 deno task sync）');
  }
  cache = await loadFromDisk();
  return cache;
}

export function lookupStatic(pathname: string): StaticFile | null {
  if (!cache) return null;
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return cache[clean] ?? cache[pathname] ?? null;
}
