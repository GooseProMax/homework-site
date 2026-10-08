'use strict';

/**
 * 极简 PostgreSQL 客户端（零依赖）
 * 只实现本项目需要的功能：SCRAM-SHA-256 / MD5 / cleartext 认证 + 简单查询协议。
 * 使用 node:net / node:tls 原生连接（兼容 Neon / Supabase / 自建 Postgres）。
 */

const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

const PROTOCOL_VERSION = 196608; // 3.0

function encodeCString(text) {
  return Buffer.concat([Buffer.from(String(text), 'utf8'), Buffer.from([0])]);
}

function backendMessage(type, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(5);
  head.write(type, 0, 'latin1');
  head.writeInt32BE(payload.length + 4, 1);
  return Buffer.concat([head, payload]);
}

function saslEscape(text) {
  return String(text).replace(/=/g, '=3D').replace(/,/g, '=2C');
}

function parseConnectionString(connectionString) {
  const raw = String(connectionString || '').trim();
  if (!raw) throw new Error('数据库连接串为空');

  let rest = raw;
  const scheme = rest.match(/^(postgres(ql)?):\/\//i);
  if (scheme) rest = rest.slice(scheme[0].length);

  let query = '';
  const qIndex = rest.indexOf('?');
  if (qIndex >= 0) {
    query = rest.slice(qIndex + 1);
    rest = rest.slice(0, qIndex);
  }

  let userInfo = '';
  const atIndex = rest.lastIndexOf('@');
  if (atIndex >= 0) {
    userInfo = rest.slice(0, atIndex);
    rest = rest.slice(atIndex + 1);
  }

  let database = '';
  const slashIndex = rest.indexOf('/');
  if (slashIndex >= 0) {
    database = rest.slice(slashIndex + 1);
    rest = rest.slice(0, slashIndex);
  }

  let host = rest;
  let port = 5432;
  const colonIndex = rest.lastIndexOf(':');
  if (colonIndex >= 0) {
    host = rest.slice(0, colonIndex);
    port = Number(rest.slice(colonIndex + 1)) || 5432;
  }

  let user = '';
  let password = '';
  const split = userInfo.indexOf(':');
  if (split >= 0) {
    user = decodeURIComponent(userInfo.slice(0, split));
    password = decodeURIComponent(userInfo.slice(split + 1));
  } else {
    user = decodeURIComponent(userInfo);
  }

  const params = new URLSearchParams(query);
  const sslMode = (params.get('sslmode') || params.get('ssl') || '').toLowerCase();
  const sslDisabled = ['disable', 'false', '0'].includes(sslMode);
  const hostIsLocal = !host || ['localhost', '127.0.0.1', '::1'].includes(host);

  return {
    host: host || 'localhost',
    port,
    user,
    password,
    database: database || user || 'postgres',
    ssl: sslDisabled ? false : !hostIsLocal || ['require', 'verify-full'].includes(sslMode),
  };
}

function readErrorField(payload, fieldType) {
  let offset = 0;
  while (offset < payload.length) {
    const type = String.fromCharCode(payload[offset]);
    if (type === '\0') break;
    const end = payload.indexOf(0, offset + 1);
    if (end < 0) break;
    if (type === fieldType) return payload.subarray(offset + 1, end).toString('utf8');
    offset = end + 1;
  }
  return '';
}

function decodeError(payload) {
  const message = readErrorField(payload, 'M') || '数据库返回未知错误';
  const code = readErrorField(payload, 'C');
  const hint = readErrorField(payload, 'H');
  const detail = readErrorField(payload, 'D');
  return [message, code ? `(SQLSTATE ${code})` : '', hint ? `提示：${hint}` : '', detail ? `详情：${detail}` : '']
    .filter(Boolean)
    .join(' ');
}

function decodeDataRow(payload) {
  const count = payload.readUInt16BE(0);
  const row = [];
  let offset = 2;
  for (let i = 0; i < count; i += 1) {
    const len = payload.readInt32BE(offset);
    offset += 4;
    if (len === -1) {
      row.push(null);
    } else {
      row.push(payload.subarray(offset, offset + len).toString('utf8'));
      offset += len;
    }
  }
  return row;
}

function literal(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return `'${String(value).replace(/'/g, "''")}'`;
}

// 把 $1/$2 参数安全地拼进 SQL（仅支持字符串/数字/布尔/null，全部转义）
function interpolate(sql, params) {
  return String(sql).replace(/\$(\d+)/g, (match, num) => literal(params[Number(num) - 1]));
}

class PgConnection {
  constructor(config, options = {}) {
    this.config = config;
    this.connectTimeout = options.connectTimeout || 12000;
    this.queryTimeout = options.queryTimeout || 15000;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.pending = null;
    this.connectResolve = null;
    this.connectReject = null;
    this.connectTimer = null;
    this.scram = null;
    this.lastError = null;
  }

  _fail(err) {
    if (this.closed && !this.pending && !this.connectReject) return;
    this.closed = true;
    this.lastError = err;
    if (this.connectReject) {
      const reject = this.connectReject;
      this.connectReject = null;
      this.connectResolve = null;
      clearTimeout(this.connectTimer);
      reject(err);
    }
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch (_) {
        /* ignore */
      }
    }
  }

  connect() {
    const { host, port, ssl } = this.config;
    return new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.connectTimer = setTimeout(() => this._fail(new Error(`连接数据库超时（${host}:${port}）`)), this.connectTimeout);

      const attach = (socket) => {
        this.socket = socket;
        socket.setNoDelay(true);
        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('error', (err) => this._fail(err));
        socket.on('close', () => {
          if (!this.closed) this._fail(this.lastError || new Error('数据库连接已断开'));
        });
      };

      try {
        if (ssl) {
          const raw = net.connect({ host, port });
          raw.once('connect', () => {
            const secure = tls.connect(
              { socket: raw, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false },
              () => this._sendStartup()
            );
            attach(secure);
            raw.on('error', (err) => this._fail(err));
          });
          raw.on('error', (err) => this._fail(err));
        } else {
          const socket = net.connect({ host, port }, () => this._sendStartup());
          attach(socket);
        }
      } catch (err) {
        this._fail(err);
      }
    });
  }

  _write(buf) {
    if (!this.socket || this.socket.destroyed) throw new Error('数据库连接不可用');
    this.socket.write(buf);
  }

  _sendStartup() {
    const params = Buffer.concat([
      encodeCString('user'),
      encodeCString(this.config.user),
      encodeCString('database'),
      encodeCString(this.config.database),
      encodeCString('application_name'),
      encodeCString('homework-site'),
      encodeCString('client_encoding'),
      encodeCString('UTF8'),
      Buffer.from([0]),
    ]);
    const head = Buffer.alloc(4);
    head.writeInt32BE(params.length + 8, 0);
    const version = Buffer.alloc(4);
    version.writeInt32BE(PROTOCOL_VERSION, 0);
    this._write(Buffer.concat([head, version, params]));
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 5) {
      const type = String.fromCharCode(this.buffer[0]);
      const len = this.buffer.readInt32BE(1);
      if (len < 4) {
        this._fail(new Error('数据库返回了非法数据'));
        return;
      }
      if (this.buffer.length < len + 1) break;
      const payload = this.buffer.subarray(5, len + 1);
      this.buffer = this.buffer.subarray(len + 1);
      try {
        this._dispatch(type, payload);
      } catch (err) {
        this._fail(err);
        return;
      }
    }
  }

  _dispatch(type, payload) {
    switch (type) {
      case 'R':
        return this._handleAuth(payload);
      case 'Z': {
        if (this.pending) {
          const pending = this.pending;
          this.pending = null;
          clearTimeout(pending.timer);
          pending.resolve({ rows: pending.rows, rowCount: pending.rows.length });
        } else if (this.connectResolve) {
          const resolve = this.connectResolve;
          this.connectResolve = null;
          this.connectReject = null;
          clearTimeout(this.connectTimer);
          resolve(this);
        }
        return;
      }
      case 'E': {
        const err = new Error(decodeError(payload));
        err.pgCode = readErrorField(payload, 'C');
        if (this.pending) {
          const pending = this.pending;
          this.pending = null;
          clearTimeout(pending.timer);
          pending.reject(err);
        } else {
          this._fail(err);
        }
        return;
      }
      case 'D':
        if (this.pending) this.pending.rows.push(decodeDataRow(payload));
        return;
      default:
        return; // S / K / N / T / C / I 等无需处理
    }
  }

  _handleAuth(payload) {
    const code = payload.readInt32BE(0);
    const body = payload.subarray(4);
    if (code === 0) return; // AuthenticationOk
    if (code === 3) return this._write(backendMessage('p', encodeCString(this.config.password)));
    if (code === 5) {
      const salt = body.subarray(0, 4);
      const inner = crypto.createHash('md5').update(this.config.password + this.config.user, 'utf8').digest('hex');
      const digest = crypto.createHash('md5').update(Buffer.concat([Buffer.from(inner, 'ascii'), salt])).digest('hex');
      return this._write(backendMessage('p', encodeCString('md5' + digest)));
    }
    if (code === 10) {
      const mechanisms = body.toString('utf8').split('\0').filter(Boolean);
      if (!mechanisms.includes('SCRAM-SHA-256')) {
        throw new Error(`数据库不支持 SCRAM-SHA-256（服务器提供：${mechanisms.join(', ')}）`);
      }
      const nonce = crypto.randomBytes(18).toString('base64');
      this.scram = { nonce, firstBare: `n=${saslEscape(this.config.user)},r=${nonce}` };
      const clientFirst = `n,,${this.scram.firstBare}`;
      const initial = Buffer.concat([
        Buffer.from('SCRAM-SHA-256\0', 'utf8'),
        Buffer.from(String(Buffer.byteLength(clientFirst, 'utf8')), 'utf8'),
        Buffer.from(clientFirst, 'utf8'),
      ]);
      return this._write(backendMessage('p', initial));
    }
    if (code === 11) {
      if (!this.scram) throw new Error('SCRAM 状态异常');
      const serverFirst = body.toString('utf8');
      const attrs = {};
      for (const part of serverFirst.split(',')) {
        const idx = part.indexOf('=');
        if (idx > 0) attrs[part.slice(0, idx)] = part.slice(idx + 1);
      }
      const serverNonce = attrs.r || '';
      if (!serverNonce.startsWith(this.scram.nonce)) throw new Error('SCRAM 校验失败：nonce 不匹配');
      const salt = Buffer.from(attrs.s || '', 'base64');
      const iterations = Number(attrs.i || 4096);
      const clientFinalNoProof = `c=biws,r=${serverNonce}`;
      const authMessage = `${this.scram.firstBare},${serverFirst},${clientFinalNoProof}`;
      const saltedPassword = crypto.pbkdf2Sync(Buffer.from(this.config.password, 'utf8'), salt, iterations, 32, 'sha256');
      const clientKey = crypto.createHmac('sha256', saltedPassword).update('Client Key').digest();
      const storedKey = crypto.createHash('sha256').update(clientKey).digest();
      const clientSignature = crypto.createHmac('sha256', storedKey).update(authMessage).digest();
      const proof = Buffer.alloc(clientKey.length);
      for (let i = 0; i < clientKey.length; i += 1) proof[i] = clientKey[i] ^ clientSignature[i];
      return this._write(backendMessage('p', Buffer.from(`${clientFinalNoProof},p=${proof.toString('base64')}`, 'utf8')));
    }
    if (code === 12) return; // AuthenticationSASLFinal
    throw new Error(`不支持的数据库认证方式（code=${code}）`);
  }

  query(sql, params = []) {
    if (this.closed) return Promise.reject(this.lastError || new Error('数据库连接已关闭'));
    if (this.pending) return Promise.reject(new Error('数据库连接正忙'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this._fail(new Error('数据库查询超时')), this.queryTimeout);
      this.pending = { resolve, reject, rows: [], timer };
      try {
        this._write(backendMessage('Q', encodeCString(interpolate(sql, params))));
      } catch (err) {
        clearTimeout(timer);
        this.pending = null;
        reject(err);
      }
    });
  }

  end() {
    this.closed = true;
    try {
      if (this.socket && !this.socket.destroyed) this._write(backendMessage('X'));
    } catch (_) {
      /* ignore */
    }
    if (this.socket) {
      try {
        this.socket.end();
      } catch (_) {
        /* ignore */
      }
    }
  }
}

class PgPool {
  constructor(connectionString, options) {
    this.config = parseConnectionString(connectionString);
    this.options = options || {};
    this.queue = Promise.resolve();
    this.conn = null;
  }

  async _ensure() {
    if (this.conn && !this.conn.closed) return this.conn;
    const conn = new PgConnection(this.config, this.options);
    await conn.connect();
    this.conn = conn;
    return conn;
  }

  query(sql, params) {
    const run = async () => {
      const conn = await this._ensure();
      try {
        return await conn.query(sql, params || []);
      } catch (err) {
        if (conn.closed) {
          this.conn = null;
          const fresh = await this._ensure();
          return fresh.query(sql, params || []);
        }
        throw err;
      }
    };
    const task = this.queue.then(run, run);
    this.queue = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  end() {
    if (this.conn) this.conn.end();
    this.conn = null;
  }
}

module.exports = { PgPool, parseConnectionString };
