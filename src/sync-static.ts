/**
 * 把网站本体（index.html / styles.css / js/*.js）打包成 src/static.ts。
 *
 * 用途有两个：
 *   1. 本机：deno task sync  —— 生成后提交/使用
 *   2. 构建时：Deno Deploy 的 Build command 里跑一次（推荐），
 *      这样仓库里不用存生成文件，改了前端也不用担心忘记同步
 *
 * 实现放在这里而不是 scripts/ 里，是为了让 Deno Deploy 的构建命令更短。
 */

const FILES: { url: string; file: string; mime: string }[] = [
  { url: '/', file: 'index.html', mime: 'text/html; charset=utf-8' },
  { url: '/index.html', file: 'index.html', mime: 'text/html; charset=utf-8' },
  { url: '/styles.css', file: 'styles.css', mime: 'text/css; charset=utf-8' },
  { url: '/js/util.js', file: 'js/util.js', mime: 'text/javascript; charset=utf-8' },
  { url: '/js/api.js', file: 'js/api.js', mime: 'text/javascript; charset=utf-8' },
  { url: '/js/store.js', file: 'js/store.js', mime: 'text/javascript; charset=utf-8' },
  { url: '/js/render.js', file: 'js/render.js', mime: 'text/javascript; charset=utf-8' },
  { url: '/js/modals.js', file: 'js/modals.js', mime: 'text/javascript; charset=utf-8' },
  { url: '/js/app.js', file: 'js/app.js', mime: 'text/javascript; charset=utf-8' },
];

function render(entries: string[]): string {
  return `/**
 * 自动生成，请勿手改！
 * 由 src/sync-static.ts 从 index.html / styles.css / js/*.js 生成。
 * 本机重新生成：deno task sync
 */

export interface StaticFile {
  body: string;
  type: string;
}

export const STATIC_FILES: Record<string, StaticFile> = {
${entries.join('\n')}
};

export function lookupStatic(pathname: string): StaticFile | null {
  const clean = pathname.length > 1 ? pathname.replace(/\\/+$/, '') : pathname;
  return STATIC_FILES[clean] ?? STATIC_FILES[pathname] ?? null;
}
`;
}

/** 生成 src/static.ts，返回资源数量 */
export async function syncStaticFiles(quiet = false): Promise<number> {
  const entries: string[] = [];
  for (const item of FILES) {
    // 用 file URL 而不是字符串路径：中文目录名不会被百分号编码搞坏
    const text = await Deno.readTextFile(new URL(`../${item.file}`, import.meta.url));
    entries.push(
      `  ${JSON.stringify(item.url)}: { body: ${JSON.stringify(text)}, type: ${JSON.stringify(item.mime)} },`,
    );
    if (!quiet) console.log(`  + ${item.file.padEnd(16)} ${(text.length / 1024).toFixed(1)} KB  → ${item.url}`);
  }
  const output = render(entries);
  await Deno.writeTextFile(new URL('./static.ts', import.meta.url), output);
  if (!quiet) {
    console.log(`\n已写入 src/static.ts（${(output.length / 1024).toFixed(1)} KB，共 ${FILES.length - 1} 个资源）`);
  }
  return FILES.length - 1;
}

if (import.meta.main) {
  await syncStaticFiles();
}
