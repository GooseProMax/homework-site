/**
 * 本机生成静态资源清单（等价于 `deno task sync`）。
 * 真正干活的代码在 src/sync-static.ts，构建时也会调用它。
 */

import { syncStaticFiles } from '../src/sync-static.ts';

await syncStaticFiles();
