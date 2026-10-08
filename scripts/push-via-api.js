'use strict';

/**
 * 不用 git push，改成走 GitHub REST API 提交（api.github.com 在国内可达，
 * 而 github.com 的 IP 被墙，所以 git push 永远超时）。
 *
 * 用法（在你自己的 PowerShell 里跑，令牌不会经过我这边）：
 *
 *   node scripts\push-via-api.js                 # 交互式输入令牌
 *   $env:GITHUB_TOKEN='ghp_xxx'; node scripts\push-via-api.js   # 或用环境变量
 *
 * 令牌要求：Fine-grained token，Repository access 勾选 homework-site，
 * Permissions → Contents 设为 Read and write。
 *
 * 脚本会自动：
 *   1. 遍历本地文件，和远端分支的树对比，只上传有变化的文件
 *   2. 创建 blobs → tree → commit → 更新分支引用
 *   3. 打印最终提交号
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const OWNER = process.env.GH_OWNER || 'GooseProMax';
const REPO = process.env.GH_REPO || 'homework-site';
const BRANCH = process.env.GH_BRANCH || 'main';
const ROOT = path.resolve(__dirname, '..');
const API = 'https://api.github.com';

// 不进仓库的文件（和 .gitignore / .vercelignore 保持一致）
const SKIP_DIRS = new Set(['.git', 'node_modules', '.tools', '.local-data', '.vercel']);
const SKIP_FILES = new Set(['.env', '.env.local', 'src/static.ts', 'src/static.ts.bak']);

let token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

function askToken() {
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', "Write-Host 'Paste your GitHub token (input is hidden), then press Enter:' -ForegroundColor Cyan; $s = Read-Host -AsSecureString; [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))"],
      { encoding: 'utf8' },
    );
    return out.trim();
  } catch (err) {
    console.error('读取令牌失败：', err.message);
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
    const message = (payload && (payload.message || payload.error)) || `HTTP ${response.status}`;
    const error = new Error(`${method} ${endpoint} → ${message}`);
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
      if (SKIP_FILES.has(rel)) continue;
      if (entry.name.endsWith('.log')) continue;
      out.push(rel);
    }
  }
  return out;
}

/** git 索引里 vs 远端里，哪些文件需要删掉 */
async function filesToDelete(baseTreeSha) {
  const wanted = new Set(['.gitignore', '.gitattributes']);
  const remote = await api('GET', `/repos/${OWNER}/${REPO}/git/trees/${baseTreeSha}?recursive=1`);
  const remotePaths = (remote.tree || []).filter((n) => n.type === 'blob').map((n) => n.path);
  const localPaths = new Set(walk(ROOT));
  const missing = remotePaths.filter((p) => !localPaths.has(p));
  return missing;
}

async function main() {
  if (!token) token = askToken();
  if (!token) {
    console.error('没有令牌，退出。');
    process.exit(1);
  }
  console.log(`\n仓库：${OWNER}/${REPO}  分支：${BRANCH}\n`);

  // 1. 当前分支指向哪里（远端可能只有旧提交，也可能分支不存在）
  let baseCommitSha = null;
  try {
    const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
    baseCommitSha = ref.object.sha;
  } catch (err) {
    if (err.status === 404) console.log('远端还没有这个分支，将创建第一个提交。');
    else throw err;
  }

  let baseTreeSha = null;
  if (baseCommitSha) {
    const baseCommit = await api('GET', `/repos/${OWNER}/${REPO}/git/commits/${baseCommitSha}`);
    baseTreeSha = baseCommit.tree.sha;
    console.log(`远端最新提交：${baseCommitSha.slice(0, 7)}  ${String(baseCommit.message).split('\n')[0]}`);
  }

  // 2. 远端已有文件的 blob sha（用于跳过硬编码未变的文件）
  const remoteBlobs = new Map();
  if (baseTreeSha) {
    const tree = await api('GET', `/repos/${OWNER}/${REPO}/git/trees/${baseTreeSha}?recursive=1`);
    (tree.tree || []).forEach((node) => {
      if (node.type === 'blob') remoteBlobs.set(node.path, node.sha);
    });
  }

  // 3. 逐个文件上传 blob
  const localPaths = walk(ROOT).sort();
  const treeEntries = [];
  let uploaded = 0;
  for (const rel of localPaths) {
    const full = path.join(ROOT, rel);
    const buffer = fs.readFileSync(full);
    const sha1 = require('node:crypto').createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buffer.length}\0`), buffer])).digest('hex');
    if (remoteBlobs.get(rel) === sha1) {
      console.log(`  = ${rel}（未变化，跳过）`);
      continue;
    }
    const blob = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
      content: buffer.toString('base64'),
      encoding: 'base64',
    });
    treeEntries.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha });
    uploaded += 1;
    console.log(`  ↑ ${rel}`);
  }

  // 4. 需要删除的远端文件（比如上一版的 src/static.ts）
  const deletions = baseTreeSha ? await filesToDelete(baseTreeSha) : [];
  deletions.forEach((p) => {
    treeEntries.push({ path: p, mode: '100644', type: 'blob', sha: null });
    console.log(`  ✗ 删除 ${p}`);
  });

  if (!treeEntries.length) {
    console.log('\n远端已经是最新，什么都不用做。');
    return;
  }

  // 5. 建 tree → commit → 移动分支
  const tree = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, {
    tree: treeEntries,
    ...(baseTreeSha ? { base_tree: baseTreeSha } : {}),
  });

  const message = process.env.COMMIT_MESSAGE
    || 'Deno Deploy 迁移：新增 server.ts / src / scripts，静态资源改为构建时生成（经 GitHub API 提交，绕过 github.com 被墙）';

  const commit = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    message,
    tree: tree.sha,
    ...(baseCommitSha ? { parents: [baseCommitSha] } : {}),
  });

  if (baseCommitSha) {
    await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });
  } else {
    await api('POST', `/repos/${OWNER}/${REPO}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
  }

  console.log(`\n✅ 提交成功：${commit.sha}`);
  console.log(`   文件变化：${uploaded} 个上传，${deletions.length} 个删除`);
  console.log(`   查看：https://github.com/${OWNER}/${REPO}/commit/${commit.sha}`);
  console.log('\n注意：你本地 git 仓库和远端现在不一致了。拉平一下即可：');
  console.log(`   git fetch origin && git reset --soft origin/${BRANCH}`);
}

main().catch((err) => {
  console.error('\n❌ 失败：', err.message);
  if (err.status === 401) console.error('   令牌无效或已过期，重新生成一个 Fine-grained token（Contents: Read and write）。');
  if (err.status === 403) console.error('   令牌权限不够：Fine-grained token 需要在 Repository permissions 里把 Contents 设为 Read and write。');
  if (err.status === 404) console.error('   仓库或分支找不到：确认 token 授权里勾了 homework-site 这个仓库。');
  if (err.status === 409 || err.status === 422) console.error('   分支被其他人更新过，重新跑一次本脚本即可。');
  process.exit(1);
});
