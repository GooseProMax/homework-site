'use strict';

/**
 * GET   /api/data       读取全部数据（需要登录）
 * PUT   /api/data       保存（乐观锁：带 baseRevision，冲突返回 409 + 服务器最新数据）
 *   ?probe=1            只返回 revision / updatedAt，用于轮询检查有没有人改过
 */

const { getStore, ConflictError } = require('./_lib/store');
const { requireAuth, readJsonBody, sendJson, fail, methodGuard } = require('./_lib/http');

const MAX_BYTES = 8 * 1024 * 1024; // 单次保存上限 8MB（图片会在前端压缩）

module.exports = async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'PUT'])) return;

  const session = requireAuth(req);
  if (!session) return fail(res, 401, '请先登录');

  const store = getStore();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const probe = url.searchParams.get('probe') === '1';

  try {
    if (req.method === 'GET') {
      const { doc, revision } = await store.readDoc();
      if (probe) return sendJson(res, 200, { revision, updatedAt: doc ? doc.updatedAt || null : null });
      return sendJson(res, 200, { revision, doc });
    }

    // PUT
    const body = await readJsonBody(req);
    const doc = body.doc;
    if (!doc || typeof doc !== 'object') return fail(res, 400, '缺少 doc 字段');

    const serialized = JSON.stringify(doc);
    if (Buffer.byteLength(serialized) > MAX_BYTES) {
      return fail(res, 413, '数据太大了（超过 8MB），请减少图片数量或压缩后再试');
    }

    const baseRevision = Number(body.baseRevision ?? body.revision ?? 0) || 0;
    const { doc: currentDoc, revision: serverRevision } = await store.readDoc();

    // 乐观锁：允许落后 2 个版本以内（同一用户多标签页的正常情况），明显过期就让他先同步
    const behind = serverRevision - baseRevision;
    if (behind > 2 || baseRevision > serverRevision) {
      return sendJson(res, 409, {
        error: '数据已被其他人修改，请先同步最新内容',
        conflict: true,
        revision: serverRevision,
        doc: currentDoc,
      });
    }

    // 口令哈希 / 成员名单属于服务端管理的字段，不能被客户端覆盖
    const previous = currentDoc && typeof currentDoc === 'object' ? currentDoc : {};
    const previousSettings = previous.settings && typeof previous.settings === 'object' ? previous.settings : {};
    doc.settings = Object.assign({}, doc.settings || {});
    ['passcodeHash', 'passcodeSalt', 'initializedAt'].forEach((key) => {
      if (previousSettings[key] !== undefined) doc.settings[key] = previousSettings[key];
    });
    if (Array.isArray(previous.members) && previous.members.length) doc.members = previous.members;

    doc.updatedAt = new Date().toISOString();
    const revision = await store.writeDoc(doc, serverRevision);
    return sendJson(res, 200, { ok: true, revision, updatedAt: doc.updatedAt });
  } catch (err) {
    if (err instanceof ConflictError || err.statusCode === 409) {
      const latest = await store.readDoc();
      return sendJson(res, 409, { error: '数据已被其他人修改，请先同步', conflict: true, revision: latest.revision, doc: latest.doc });
    }
    console.error('[api/data]', err);
    return fail(res, 500, `服务器错误：${err.message}`);
  }
};
