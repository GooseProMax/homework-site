'use strict';

/**
 * 数据存储层：同一套接口，三种后端，按环境变量自动选择。
 *   1. Postgres（推荐）  : DATABASE_URL / POSTGRES_URL
 *   2. Upstash Redis     : KV_REST_API_URL + KV_REST_API_TOKEN（或 UPSTASH_REDIS_REST_URL/TOKEN）
 *   3. 本地 JSON 文件    : 只能在 node server/dev-server.js 下使用（Vercel 上不可写）
 *
 * 并发控制：乐观锁。读的时候拿到 revision，写的时候带上 revision，
 * 服务端 revision 不一致就抛 ConflictError，前端提示「有人刚改过」。
 */

const fs = require('node:fs');
const path = require('node:path');
const { PgPool } = require('./pg');

class ConflictError extends Error {
  constructor(message = '数据已被其他人修改') {
    super(message);
    this.name = 'ConflictError';
    this.statusCode = 409;
  }
}

const TABLE = 'homework_site_state';
const DOC_ID = 'main';

/* ------------------------------------------------------------------ */
/* Postgres                                                            */
/* ------------------------------------------------------------------ */

class PostgresStore {
  constructor(connectionString) {
    this.pool = new PgPool(connectionString);
    this.kind = 'postgres';
    this.ready = null;
  }

  async init() {
    if (!this.ready) {
      this.ready = (async () => {
        await this.pool.query(
          `CREATE TABLE IF NOT EXISTS ${TABLE} (
             id TEXT PRIMARY KEY,
             doc JSONB NOT NULL,
             revision INTEGER NOT NULL DEFAULT 0,
             updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
           )`
        );
        await this.pool.query(
          `INSERT INTO ${TABLE} (id, doc, revision) VALUES ($1, $2::jsonb, 0) ON CONFLICT (id) DO NOTHING`,
          [DOC_ID, 'null']
        );
      })().catch((err) => {
        this.ready = null;
        throw err;
      });
    }
    return this.ready;
  }

  async readDoc() {
    await this.init();
    const { rows } = await this.pool.query(`SELECT doc, revision FROM ${TABLE} WHERE id = $1`, [DOC_ID]);
    if (!rows.length || rows[0][0] === null || rows[0][0] === 'null') return { doc: null, revision: 0 };
    let doc = null;
    try {
      doc = JSON.parse(rows[0][0]);
    } catch (_) {
      doc = null;
    }
    return { doc, revision: Number(rows[0][1]) || 0 };
  }

  async writeDoc(doc, expectedRevision) {
    await this.init();
    const json = JSON.stringify(doc);
    const { rows } = await this.pool.query(
      `UPDATE ${TABLE}
          SET doc = $1::jsonb, revision = revision + 1, updated_at = NOW()
        WHERE id = $2 AND revision = $3
        RETURNING revision`,
      [json, DOC_ID, Number(expectedRevision) || 0]
    );
    if (!rows.length) throw new ConflictError();
    return Number(rows[0][0]);
  }

  async health() {
    await this.init();
    const { rows } = await this.pool.query('SELECT 1');
    return { store: this.kind, ok: rows.length === 1 };
  }
}

/* ------------------------------------------------------------------ */
/* Upstash Redis（HTTP REST，无需任何 SDK）                             */
/* ------------------------------------------------------------------ */

class RedisRestStore {
  constructor(url, token) {
    this.url = String(url).replace(/\/+$/, '');
    this.token = token;
    this.kind = 'redis';
    this.key = 'homework-site:doc';
  }

  async _command(...args) {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args.map((arg) => String(arg))),
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (_) {
      payload = null;
    }
    if (!response.ok || (payload && payload.error)) {
      throw new Error(`Redis 请求失败：${(payload && payload.error) || response.status} ${text.slice(0, 200)}`);
    }
    return payload ? payload.result : null;
  }

  async init() {
    return null;
  }

  async readDoc() {
    const raw = await this._command('GET', this.key);
    if (!raw) return { doc: null, revision: 0 };
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      return { doc: null, revision: 0 };
    }
    if (parsed && typeof parsed === 'object' && 'doc' in parsed) {
      return { doc: parsed.doc, revision: Number(parsed.revision) || 0 };
    }
    return { doc: parsed, revision: 0 };
  }

  async writeDoc(doc, expectedRevision) {
    const current = await this.readDoc();
    if (Number(current.revision) !== Number(expectedRevision || 0)) throw new ConflictError();
    const revision = Number(current.revision) + 1;
    await this._command('SET', this.key, JSON.stringify({ doc, revision }));
    return revision;
  }

  async health() {
    const pong = await this._command('PING');
    return { store: this.kind, ok: String(pong).toUpperCase() === 'PONG' };
  }
}

/* ------------------------------------------------------------------ */
/* 本地 JSON 文件                                                       */
/* ------------------------------------------------------------------ */

class FileStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.kind = 'file';
    this.cache = null;
  }

  async init() {
    if (!fs.existsSync(this.filePath)) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify({ doc: null, revision: 0 }, null, 2), 'utf8');
    }
    return null;
  }

  _load() {
    if (this.cache) return this.cache;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.cache = { doc: parsed.doc ?? null, revision: Number(parsed.revision) || 0 };
    } catch (_) {
      this.cache = { doc: null, revision: 0 };
    }
    return this.cache;
  }

  async readDoc() {
    await this.init();
    const loaded = this._load();
    return { doc: loaded.doc, revision: loaded.revision };
  }

  async writeDoc(doc, expectedRevision) {
    await this.init();
    const loaded = this._load();
    if (Number(loaded.revision) !== Number(expectedRevision || 0)) throw new ConflictError();
    this.cache = { doc, revision: Number(loaded.revision) + 1 };
    fs.writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2), 'utf8');
    return this.cache.revision;
  }

  async health() {
    await this.init();
    return { store: this.kind, ok: true, file: this.filePath };
  }
}

/* ------------------------------------------------------------------ */
/* 工厂                                                                */
/* ------------------------------------------------------------------ */

let singleton = null;

function resolveStore() {
  const env = process.env;
  const pgUrl = env.DATABASE_URL || env.POSTGRES_URL || env.POSTGRES_PRISMA_URL || env.POSTGRES_URL_NON_POOLING;
  if (pgUrl) return new PostgresStore(pgUrl);

  const redisUrl = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const redisToken = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (redisUrl && redisToken) return new RedisRestStore(redisUrl, redisToken);

  const filePath = env.DATA_FILE || path.join(process.cwd(), '.local-data', 'data.json');
  return new FileStore(filePath);
}

function getStore() {
  if (!singleton) singleton = resolveStore();
  return singleton;
}

module.exports = { getStore, ConflictError, TABLE };
