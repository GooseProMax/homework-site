'use strict';

/**
 * 用 GitHub REST API 推送（不依赖被墙的 github.com，也不需要梯子）。
 *
 * 用法：
 *   node scripts\push-via-api.js                # 交互式输入令牌（隐藏输入）
 *   set GITHUB_TOKEN=github_pat_xxx && node scripts\push-via-api.js
 *
 * 令牌要求：Fine-grained personal access token
 *   - Repository access → Only select repositories → 勾 homework-site
 *   - Repository permissions → Contents → Read and write
 *
 * 脚本会：对比远端树 → 只上传有变化的文件 → 创建 blobs / tree / commit → 更新分支。
 * 由于拿不到被墙的 github.com，本地 git 的历史会和远端逐渐分叉，
 * 建议以后统一用这个脚本发布（约 10 秒完成）。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const OWNER = process.env.GH_OWNER || 'GooseProMax';
const REPO = process.env.GH_REPO || 'homework-site';
const BRANCH = process.env.GH_BRANCH || 'main';
const ROOT = path.resolve(__dirname, '..');
const API = 'https://api.github.com';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.tools', '.local-data', '.vercel']);
const SKIP_FILES = new Set(['.env', '.env.local', 'src/static.ts', 'src/static.ts.bak']);

let token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

function askToken() {
  console.log('没有检测到 GITHUB_TOKEN，将用隐藏输入方式读取（令牌不会落盘）。');
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "Write-Host 'Paste your GitHub token, then press Enter:' -ForegroundColor Cyan; $s = Read-Host -AsSecureString; [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))",
      ],
      { encoding: 'utf8' },
    );
    return out.trim();
  } catch (err) {
    console.error('读取令牌失败：', err.message);
    console.error('可以改用环境变量：set GITHUB_TOKEN=xxx && node scripts\\push-via-api.js');
    return '';
  }
}

async function api(method, endpoint, body) {
  const response = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'homework-site-push',
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text.slice(0, 300) };
  }
  if (!response.ok) {
    const error = new Error(`${method} ${endpoint} → ${(payload && (payload.message || payload.error)) || `HTTP ${response.status}`}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function walk(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...walk(path.join(dir, entry.name), rel));
    } else {
      if (SKIP_FILES.has(rel) || entry.name.endsWith('.log')) continue;
      out.push(rel);
    }
  }
  return out;
}

function gitBlobSha(buffer) {
  return crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buffer.length}\0`), buffer])).digest('hex');
}

async function main() {
  if (!token) token = askToken();
  if (!token) process.exit(1);

  console.log(`\n仓库：${OWNER}/${REPO}   分支：${BRANCH}\n`);

  let baseCommitSha = null;
  try {
    const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
    baseCommitSha = ref.object.sha;
  } catch (err) {
    if (err.status === 404) console.log('远端还没有这个分支，将创建第一个提交。');
    else throw err;
  }

  let baseTreeSha = null;
  const remoteBlobs = new Map();
  if (baseCommitSha) {
    const baseCommit = await api('GET', `/repos/${OWNER}/${REPO}/git/commits/${baseCommitSha}`);
    baseTreeSha = baseCommit.tree.sha;
    console.log(`远端最新提交：${baseCommitSha.slice(0, 7)}  ${String(baseCommit.message).split('\n')[0].slice(0, 50)}`);
    const tree = await api('GET', `/repos/${OWNER}/${REPO}/git/trees/${baseTreeSha}?recursive=1`);
    (tree.tree || []).forEach((node) => {
      if (node.type === 'blob') remoteBlobs.set(node.path, node.sha);
    });
  }

  const localPaths = walk(ROOT).sort();
  const treeEntries = [];
  let uploaded = 0;

  for (const rel of localPaths) {
    const buffer = fs.readFileSync(path.join(ROOT, rel));
    if (remoteBlobs.get(rel) === gitBlobSha(buffer)) continue;
    const blob = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
      content: buffer.toString('base64'),
      encoding: 'base64',
    });
    treeEntries.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha });
    uploaded += 1;
    console.log(`  ↑ ${rel}`);
  }

  const localSet = new Set(localPaths);
  const deletions = Array.from(remoteBlobs.keys()).filter((p) => !localSet.has(p));
  deletions.forEach((p) => {
    treeEntries.push({ path: p, mode: '100644', type: 'blob', sha: null });
    console.log(`  ✗ 删除 ${p}`);
  });

  if (!treeEntries.length) {
    console.log('\n远端已经是最新，无需提交。');
    return;
  }

  const tree = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, {
    tree: treeEntries,
    ...(baseTreeSha ? { base_tree: baseTreeSha } : {}),
  });

  const message = process.env.COMMIT_MESSAGE
    || `通过 GitHub API 更新（${uploaded} 个文件${deletions.length ? `，删除 ${deletions.length} 个` : ''}）`;

  const commit = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    message,
    tree: tree.sha,
    ...(baseCommitSha ? { parents: [baseCommitSha] } : {}),
  });

  if (baseCommitSha) {
    await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha });
  } else {
    await api('POST', `/repos/${OWNER}/${REPO}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
  }

  console.log(`\n✅ 提交成功：${commit.sha}`);
  console.log(`   上传 ${uploaded} 个，删除 ${deletions.length} 个`);
  console.log(`   https://github.com/${OWNER}/${REPO}/commit/${commit.sha}`);
}

main().catch((err) => {
  console.error('\n❌ 失败：', err.message);
  if (err.status === 401) console.error('   令牌无效或已过期，重新生成 Fine-grained token。');
  if (err.status === 403) console.error('   权限不足：Fine-grained token 的 Contents 需要 Read and write。');
  if (err.status === 404) console.error('   找不到仓库/分支：确认令牌授权里勾选了 homework-site。');
  if (err.status === 409 || err.status === 422) console.error('   远端被并发更新过，重跑一次本脚本即可。');
  process.exit(1);
});
