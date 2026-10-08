'use strict';

/**
 * 登录 / 初始化 / 会话
 *
 *  GET  /api/auth?action=status   站点是否已初始化、当前令牌是否有效、有没有成员
 *  POST /api/auth  {action:'setup',  passcode, nickname}         站点首次初始化（仅当尚未初始化）
 *  POST /api/auth  {action:'intro',  passcode, nickname}         第一次进来：验口令 + 报昵称
 *  POST /api/auth  {action:'login',  passcode?, member?}         以后进来：口令 或 直接选成员
 *  POST /api/auth  {action:'passcode', passcode, newPasscode}    修改口令（需登录）
 */

const { getStore, ConflictError } = require('./_lib/store');
const {
  hashPasscode,
  verifyPasscode,
  newSalt,
  sign,
  requireAuth,
  readJsonBody,
  sendJson,
  fail,
  methodGuard,
} = require('./_lib/http');

const MAX_RETRY = 3;

function defaultDoc() {
  const now = new Date().toISOString();
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    settings: {
      title: '本学期作业板',
      semester: '',
      weeks: 16,
      passcodeSalt: '',
      passcodeHash: '',
      initializedAt: null,
    },
    courses: [],
    assignments: [],
    members: [],
  };
}

function normalizeDoc(doc) {
  const base = defaultDoc();
  if (!doc || typeof doc !== 'object') return base;
  return {
    ...base,
    ...doc,
    settings: { ...base.settings, ...(doc.settings || {}) },
    courses: Array.isArray(doc.courses) ? doc.courses : [],
    assignments: Array.isArray(doc.assignments) ? doc.assignments : [],
    members: Array.isArray(doc.members) ? doc.members : [],
  };
}

/** 乐观锁下的「读-改-写」，冲突自动重试 */
async function mutate(store, mutator) {
  let lastError = null;
  for (let attempt = 0; attempt < MAX_RETRY; attempt += 1) {
    const { doc: raw, revision } = await store.readDoc();
    const doc = normalizeDoc(raw);
    const result = await mutator(doc);
    if (result && result.abort) return result;
    try {
      const revision2 = await store.writeDoc(doc, revision);
      return { doc, revision: revision2, ...(result && result.extra ? result.extra : {}) };
    } catch (err) {
      if (err instanceof ConflictError || err.statusCode === 409) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastError || new ConflictError();
}

function publicState(doc) {
  const settings = doc.settings || {};
  return {
    initialized: Boolean(settings.passcodeHash),
    title: settings.title || '本学期作业板',
    semester: settings.semester || '',
    weeks: settings.weeks || 16,
    courses: doc.courses || [],
    members: (doc.members || []).map((m) => ({ nickname: m.nickname, joinedAt: m.joinedAt })),
  };
}

module.exports = async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'POST'])) return;
  const store = getStore();

  try {
    if (req.method === 'GET') {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const action = url.searchParams.get('action') || 'status';
      const session = requireAuth(req);
      const { doc: raw } = await store.readDoc();
      const doc = normalizeDoc(raw);

      if (action === 'status') {
        return sendJson(res, 200, {
          ...publicState(doc),
          authed: Boolean(session),
          nickname: session ? session.nickname : null,
          storage: store.kind,
          secretMissing: Boolean(process.env.VERCEL) && !process.env.APP_SECRET,
        });
      }
      if (action === 'doc') {
        if (!session) return fail(res, 401, '请先登录');
        return sendJson(res, 200, { doc, nickname: session.nickname });
      }
      return fail(res, 400, `未知的 action：${action}`);
    }

    const body = await readJsonBody(req);
    const action = String(body.action || '').trim();
    const passcode = typeof body.passcode === 'string' ? body.passcode : '';
    const nickname = String(body.nickname || '').trim().slice(0, 24);

    /* ---------------- 初始化（只在还没设置口令时可用） ---------------- */
    if (action === 'setup') {
      const envPass = process.env.SITE_PASSCODE || '';
      const effectivePass = envPass || passcode;
      if (effectivePass.length < 4) return fail(res, 400, '口令至少 4 位');
      if (!nickname) return fail(res, 400, '请填写你的昵称');

      const outcome = await mutate(store, (doc) => {
        if (doc.settings.passcodeHash) return { abort: true, status: 409, message: '站点已经初始化过了，请直接用口令登录' };
        const salt = newSalt();
        doc.settings.passcodeSalt = salt;
        doc.settings.passcodeHash = hashPasscode(effectivePass, salt);
        doc.settings.initializedAt = new Date().toISOString();
        doc.members = [{ nickname, joinedAt: new Date().toISOString() }];
        return { extra: { nickname } };
      });
      if (outcome.abort) return fail(res, outcome.status, outcome.message);
      return sendJson(res, 200, {
        ok: true,
        token: sign({ nickname, role: 'member' }),
        nickname,
        revision: outcome.revision,
        usedEnvPasscode: Boolean(envPass),
      });
    }

    /* ---------------- 首次进入（自报昵称） ---------------- */
    if (action === 'intro') {
      if (!nickname) return fail(res, 400, '请填写你的昵称');
      let denied = null;
      const outcome = await mutate(store, (doc) => {
        if (!doc.settings.passcodeHash) {
          denied = { status: 428, message: '站点还没有初始化，请先设置一个口令', extra: { needSetup: true } };
          return { abort: true };
        }
        if (!verifyPasscode(passcode, doc.settings.passcodeSalt, doc.settings.passcodeHash)) {
          denied = { status: 401, message: '口令不正确' };
          return { abort: true };
        }
        const now = new Date().toISOString();
        const index = doc.members.findIndex((m) => m.nickname === nickname);
        if (index >= 0) doc.members[index] = { ...doc.members[index], lastSeenAt: now };
        else doc.members.push({ nickname, joinedAt: now });
        return { extra: { nickname } };
      });
      if (denied) return fail(res, denied.status, denied.message, denied.extra || {});
      return sendJson(res, 200, { ok: true, token: sign({ nickname, role: 'member' }), nickname });
    }

    /* ---------------- 再次进入（口令 + 昵称，选已有昵称也必须给口令） ---------------- */
    if (action === 'login') {
      const member = String(body.member || '').trim().slice(0, 24);
      if (!member) return fail(res, 400, '请选择或填写昵称');

    // 先取出哈希校验口令：无论是否已有成员，都必须验证，
    // 否则知道某个昵称就能绕过小组口令进来。
    let passInfo = null;
    try {
      const probe = await mutate(store, (doc) => {
        if (!doc.settings.passcodeHash) {
          return { abort: { status: 428, message: '站点还没有初始化', extra: { needSetup: true } } };
        }
        // 注意：extra 里的字段会被 mutate() 展开到返回值顶层
        return { extra: { salt: doc.settings.passcodeSalt, hash: doc.settings.passcodeHash } };
      });
      passInfo = { salt: probe.salt, hash: probe.hash };
    } catch (err) {
      const rejection = denied(err);
      if (rejection) return rejection;
      throw err;
    }
    if (!verifyPasscode(passcode, passInfo.salt, passInfo.hash)) return fail(res, 401, '口令不正确');

      const outcome = await mutate(store, (doc) => {
        if (!doc.members.some((m) => m.nickname === member)) {
          doc.members.push({ nickname: member, joinedAt: new Date().toISOString() });
        }
        return {};
      });
      return sendJson(res, 200, { ok: true, token: sign({ nickname: member, role: 'member' }), nickname: member, revision: outcome.revision });
    }

    /* ---------------- 修改口令 ---------------- */
    if (action === 'passcode') {
      const session = requireAuth(req);
      if (!session) return fail(res, 401, '请先登录');
      const next = String(body.newPasscode || '');
      if (next.length < 4) return fail(res, 400, '新口令至少 4 位');
      let denied = null;
      const outcome = await mutate(store, (doc) => {
        if (!verifyPasscode(passcode, doc.settings.passcodeSalt, doc.settings.passcodeHash)) {
          denied = { status: 401, message: '当前口令不正确' };
          return { abort: true };
        }
        doc.settings.passcodeSalt = newSalt();
        doc.settings.passcodeHash = hashPasscode(next, doc.settings.passcodeSalt);
        return {};
      });
      if (denied) return fail(res, denied.status, denied.message);
      return sendJson(res, 200, { ok: true, message: '口令已更新，其他人下次需要重新输入口令' });
    }

    if (action === 'logout') return sendJson(res, 200, { ok: true });

    return fail(res, 400, `未知的 action：${action}`);
  } catch (err) {
    console.error('[api/auth]', err);
    return fail(res, 500, `服务器错误：${err.message}`);
  }
};
