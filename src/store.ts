/**
 * 存储适配层：同一套接口，三种后端，自动选择。
 *
 *   1. Deno KV      —— Deno Deploy 自带数据库，零配置（推荐，默认就走这个）
 *   2. 本地 JSON 文件 —— 在本机 `deno run -A server.ts` 开发时用
 *   3. 内存          —— 兜底（比如只读文件系统），进程重启即丢，仅用于演示
 *
 * 并发控制：乐观锁。读文档时拿到 revision，写回时必须带同一个 revision，
 * 对不上就抛 ConflictError，前端会把两边的改动合并。
 */

export class ConflictError extends Error {
  constructor(message = '数据已被其他人修改') {
    super(message);
    this.name = 'ConflictError';
    this.statusCode = 409;
  }
}

export interface StoreHealth {
  store: string;
  ok: boolean;
  detail?: string;
}

export interface Store {
  readonly kind: string;
  readDoc(): Promise<{ doc: Record<string, unknown> | null; revision: number }>;
  writeDoc(doc: Record<string, unknown>, expectedRevision: number): Promise<number>;
  health(): Promise<StoreHealth>;
}

const KV_DOC_KEY = ['homework-site', 'doc'];
const KV_REV_KEY = ['homework-site', 'revision'];

/** Deno Deploy 自带的 KV 数据库 */
export class DenoKvStore implements Store {
  readonly kind = 'deno-kv';

  constructor(private kv: Deno.Kv) {}

  async readDoc() {
    const [docEntry, revEntry] = await Promise.all([
      this.kv.get<Record<string, unknown>>(KV_DOC_KEY),
      this.kv.get<number>(KV_REV_KEY),
    ]);
    return { doc: docEntry.value ?? null, revision: Number(revEntry.value) || 0 };
  }

  /** 用 versionstamp 做真正的 CAS：写入瞬间版本变了就失败，不会互相覆盖 */
  async writeDoc(doc: Record<string, unknown>, expectedRevision: number) {
    const entry = await this.kv.get<number>(KV_REV_KEY);
    const current = Number(entry.value) || 0;
    if (current !== Number(expectedRevision || 0)) throw new ConflictError();
    const revision = current + 1;
    const result = await this.kv.atomic()
      .check({ key: KV_REV_KEY, versionstamp: entry.versionstamp })
      .set(KV_REV_KEY, revision)
      .set(KV_DOC_KEY, doc)
      .commit();
    if (!result.ok) throw new ConflictError();
    return revision;
  }

  async health(): Promise<StoreHealth> {
    await this.kv.get(KV_REV_KEY);
    return { store: this.kind, ok: true, detail: 'Deno KV（平台自带，免费）' };
  }
}

/** 本机开发：JSON 文件 */
export class FileStore implements Store {
  readonly kind = 'file';

  constructor(private path: string) {}

  private async ensure() {
    try {
      await Deno.stat(this.path);
    } catch {
      const dir = this.path.replace(/[/\\][^/\\]+$/, '');
      if (dir) await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(this.path, JSON.stringify({ doc: null, revision: 0 }, null, 2));
    }
  }

  async readDoc() {
    await this.ensure();
    try {
      const raw = await Deno.readTextFile(this.path);
      const parsed = JSON.parse(raw);
      return { doc: parsed.doc ?? null, revision: Number(parsed.revision) || 0 };
    } catch {
      return { doc: null, revision: 0 };
    }
  }

  async writeDoc(doc: Record<string, unknown>, expectedRevision: number) {
    const current = await this.readDoc();
    if (Number(current.revision) !== Number(expectedRevision || 0)) throw new ConflictError();
    const revision = Number(current.revision) + 1;
    await Deno.writeTextFile(this.path, JSON.stringify({ doc, revision }, null, 2));
    return revision;
  }

  async health(): Promise<StoreHealth> {
    await this.ensure();
    return { store: this.kind, ok: true, detail: this.path };
  }
}

/** 只能内存时兜底 */
export class MemoryStore implements Store {
  readonly kind = 'memory';
  private doc: Record<string, unknown> | null = null;
  private revision = 0;

  async readDoc() {
    return { doc: this.doc, revision: this.revision };
  }

  async writeDoc(doc: Record<string, unknown>, expectedRevision: number) {
    if (Number(this.revision) !== Number(expectedRevision || 0)) throw new ConflictError();
    this.doc = doc;
    this.revision += 1;
    return this.revision;
  }

  async health(): Promise<StoreHealth> {
    return { store: this.kind, ok: true, detail: '内存存储（重启即丢，仅演示用）' };
  }
}

let singleton: Store | null = null;

/** 按环境自动挑一个后端 */
export async function getStore(): Promise<Store> {
  if (singleton) return singleton;

  try {
    const kv = await Deno.openKv();
    singleton = new DenoKvStore(kv);
    return singleton;
  } catch (err) {
    console.warn('[store] Deno KV 不可用，改用文件存储：', (err as Error).message);
  }

  const filePath = Deno.env.get('DATA_FILE') ?? '.local-data/data.json';
  try {
    singleton = new FileStore(filePath);
    await singleton.health();
    return singleton;
  } catch (err) {
    console.warn('[store] 文件存储不可用，改用内存存储：', (err as Error).message);
  }

  singleton = new MemoryStore();
  return singleton;
}

export function resetStoreForTests() {
  singleton = null;
}
