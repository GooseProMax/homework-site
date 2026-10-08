'use strict';

/**
 * 本地开发服务器（零依赖）：模拟 Vercel 的静态文件 + /api/* 函数路由。
 *
 *   node server/dev-server.js            # 默认 http://127.0.0.1:5173
 *   node server/dev-server.js --port 8080
 *
 * 它会读取项目根目录的 .env.local（如果存在），并在没有配置数据库时
 * 自动把数据存到 .local-data/data.json，方便你在本机先试通全部功能。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const API_DIR = path.join(ROOT, 'api');

/* ---------------------------- 读取 .env.local ---------------------------- */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(ROOT, '.env.local'));
loadEnvFile(path.join(ROOT, '.env'));

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const PORT = Number(argValue('--port', process.env.PORT || 5173));
const HOST = argValue('--host', '127.0.0.1');

const hasDb = Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.KV_REST_API_URL);
if (!process.env.DATA_FILE) process.env.DATA_FILE = path.join(ROOT, '.local-data', 'data.json');
if (!process.env.APP_SECRET) process.env.APP_SECRET = 'local-dev-secret';

/* ------------------------------ 静态文件 --------------------------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function resolveStatic(pathname) {
  const decoded = decodeURIComponent(pathname.split('?')[0]);
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  let target = path.join(ROOT, relative);
  if (!target.startsWith(ROOT)) return null; // 防止 ../ 逃逸
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
  if (!fs.existsSync(target) && !path.extname(target) && fs.existsSync(`${target}.html`)) target = `${target}.html`;
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) return null;
  return target;
}

function serveStatic(req, res, file) {
  const ext = path.extname(file).toLowerCase();
  const stat = fs.statSync(file);
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(file).pipe(res);
}

/* -------------------------------- API ----------------------------------- */
function loadApiHandler(name) {
  const file = path.join(API_DIR, `${name}.js`);
  if (!fs.existsSync(file)) return null;
  delete require.cache[require.resolve(file)];
  return require(file);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  const type = String(req.headers['content-type'] || '');
  if (type.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch (_) {
      return text;
    }
  }
  return text;
}

async function handleApi(req, res, name) {
  const handler = loadApiHandler(name);
  if (!handler) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ error: `没有这个接口：/api/${name}` }));
  }
  try {
    req.body = await readBody(req);
    return await handler(req, res);
  } catch (err) {
    console.error('[dev-server]', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    return res.end(JSON.stringify({ error: err.message }));
  }
}

/* ------------------------------- 启动 ----------------------------------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const apiMatch = url.pathname.match(/^\/api\/([A-Za-z0-9_-]+)\/?$/);
  if (apiMatch) return handleApi(req, res, apiMatch[1]);

  const file = resolveStatic(url.pathname);
  if (file) return serveStatic(req, res, file);

  if (url.pathname.startsWith('/api/')) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ error: '接口不存在' }));
  }

  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.end('<h1>404</h1><p>找不到页面。<a href="/">回到首页</a></p>');
});

server.listen(PORT, HOST, () => {
  const lines = [
    '',
    '  作业云服务器 · 本地开发模式已启动',
    `  网页地址   http://${HOST}:${PORT}`,
    `  自检接口   http://${HOST}:${PORT}/api/health`,
    `  数据存储   ${hasDb ? '数据库（来自 .env.local）' : `本地文件 ${process.env.DATA_FILE}`}`,
    '',
    '  按 Ctrl+C 停止',
    '',
  ];
  console.log(lines.join('\n'));
});

module.exports = { server, PORT, HOST, ROOT };
