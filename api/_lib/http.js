'use strict';

/**
 * 通用工具：请求体解析、JSON 响应、口令哈希、HMAC 签名令牌。
 * 全部使用 node:crypto，无第三方依赖。
 */

const crypto = require('node:crypto');

function getSecret() {
  const secret = process.env.APP_SECRET || process.env.SESSION_SECRET || '';
  if (secret) return secret;
  if (process.env.VERCEL) {
    // 线上必须配置 APP_SECRET，否则每次冷启动都会让所有人掉线
    return 'insecure-fallback-secret-please-set-APP_SECRET';
  }
  return 'local-dev-secret';
}

function hashPasscode(passcode, salt) {
  // 10 万次迭代的 PBKDF2，够挡住手抄口令的暴力枚举
  return crypto.pbkdf2Sync(String(passcode), salt, 100000, 32, 'sha256').toString('hex');
}

function verifyPasscode(passcode, salt, expectedHash) {
  const actual = Buffer.from(hashPasscode(passcode, salt), 'hex');
  const expected = Buffer.from(String(expectedHash || ''), 'hex');
  if (actual.length !== expected.length || expected.length === 0) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function newSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function sign(payload, ttlMs = 1000 * 60 * 60 * 24 * 90) {
  const body = { ...payload, exp: Date.now() + ttlMs };
  const data = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  const mac = crypto.createHmac('sha256', getSecret()).update(data).digest('base64url');
  return `${data}.${mac}`;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const index = token.lastIndexOf('.');
  if (index <= 0) return null;
  const data = token.slice(0, index);
  const mac = token.slice(index + 1);
  const expected = crypto.createHmac('sha256', getSecret()).update(data).digest('base64url');
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const body = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!body.exp || body.exp < Date.now()) return null;
    return body;
  } catch (_) {
    return null;
  }
}

async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      try {
        return JSON.parse(req.body);
      } catch (_) {
        return {};
      }
    }
    return req.body;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 20 * 1024 * 1024) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (_) {
    return {};
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function fail(res, status, message, extra = {}) {
  sendJson(res, status, { error: message, ...extra });
}

function getAuthToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();
  return '';
}

/** 校验登录令牌；未登录返回 null（调用方决定如何响应） */
function requireAuth(req) {
  return verify(getAuthToken(req));
}

/** 只允许 GET/POST 等白名单方法 */
function methodGuard(req, res, allowed) {
  const method = (req.method || 'GET').toUpperCase();
  if (!allowed.includes(method)) {
    res.setHeader('Allow', allowed.join(', '));
    fail(res, 405, `不支持的请求方法：${method}`);
    return false;
  }
  return true;
}

module.exports = {
  hashPasscode,
  verifyPasscode,
  newSalt,
  sign,
  verify,
  readJsonBody,
  sendJson,
  fail,
  requireAuth,
  methodGuard,
  getSecret,
};
