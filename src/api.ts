/**
 * 文档模型 + 登录 / 数据读写接口（行为与 Node 版一致，前端无需改动）。
 */

import type { Store } from './store.ts';
import { ConflictError } from './store.ts';
import {
  currentSession,
  fail,
  hashPasscode,
  json,
  newSalt,
  readJsonBody,
  signSession,
  verifyPasscode,
} from './util.ts';

const MAX_BYTES = 8 * 1024 * 1024; // 单次保存上限 8MB（图片在前端已压缩）
const MAX_RETRY = 4;

export interface HomeworkDoc {
  version: number;
  createdAt: string;
  updatedAt: string;
  settings: Record<string, unknown>;
  courses: unknown[];
  assignments: unknown[];
  members: { nickname: string; joinedAt?: string; lastSeenAt?: string }[];
}

export function defaultDoc(): HomeworkDoc {
  const now = new Date().toISOString();
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    settings: {
      title: '本学期作业板',
      semester: '',
      semesterStart: '',
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

export function normalizeDoc(raw: unknown): HomeworkDoc {
  const base = defaultDoc();
  if (!raw || typeof raw !== 'object') return base;
  const input = raw as Record<string, unknown>;
  return {
    ...base,
    ...input,
    settings: { ...base.settings, ...((input.settings as Record<string, unknown>) ?? {}) },
    courses: Array.isArray(input.courses) ? input.courses : [],
    assignments: Array.isArray(input.assignments) ? input.assignments : [],
    members: Array.isArray(input.members) ? input.members as HomeworkDoc['members'] : [],
  };
}

/** 读-改-写，遇到并发冲突自动重试 */
async function mutate(
  store: Store,
  mutator: (doc: HomeworkDoc) => { abort?: { status: number; message: string; extra?: Record<string, unknown> }; extra?: Record<string, unknown> },
): Promise<{ doc: HomeworkDoc; revision: number; extra: Record<string, unknown> }> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_RETRY; attempt += 1) {
    const { doc: raw, revision } = await store.readDoc();
    const doc = normalizeDoc(raw);
    const result = mutator(doc);
    if (result.abort) {
      const err = new Error(result.abort.message) as Error & { status: number; extra?: Record<string, unknown> };
      err.status = result.abort.status;
      err.extra = result.abort.extra;
      throw err;
    }
    try {
      const next = await store.writeDoc(doc as unknown as Record<string, unknown>, revision);
      return { doc, revision: next, extra: result.extra ?? {} };
    } catch (err) {
      if (err instanceof ConflictError || (err as { statusCode?: number }).statusCode === 409) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastError ?? new ConflictError();
}

function publicState(doc: HomeworkDoc) {
  const settings = doc.settings as Record<string, unknown>;
  return {
    initialized: Boolean(settings.passcodeHash),
    title: (settings.title as string) || '本学期作业板',
    semester: (settings.semester as string) || '',
    weeks: (settings.weeks as number) || 16,
    courses: doc.courses,
    members: doc.members.map((m) => ({ nickname: m.nickname, joinedAt: m.joinedAt })),
  };
}

function denied(err: unknown): Response | null {
  const candidate = err as { status?: number; message?: string; extra?: Record<string, unknown> };
  if (candidate && typeof candidate.status === 'number' && candidate.status >= 400 && candidate.status < 500) {
    return fail(candidate.message ?? '请求被拒绝', candidate.status, candidate.extra ?? {});
  }
  return null;
}

/* =============================== 认证接口 =============================== */

export async function authRoute(req: Request, store: Store, url: URL): Promise<Response> {
  if (req.method === 'GET') {
    const action = url.searchParams.get('action') ?? 'status';
    const session = await currentSession(req);
    const { doc: raw } = await store.readDoc();
    const doc = normalizeDoc(raw);

    if (action === 'status') {
      return json({
        ...publicState(doc),
        authed: Boolean(session),
        nickname: session ? session.nickname : null,
        storage: store.kind,
        secretConfigured: Boolean(Deno.env.get('APP_SECRET')),
      });
    }
    if (action === 'doc') {
      if (!session) return fail('请先登录', 401);
      return json({ doc, nickname: session.nickname });
    }
    return fail(`未知的 action：${action}`, 400);
  }

  if (req.method !== 'POST') return fail('不支持的请求方法', 405);

  const body = await readJsonBody(req);
  const action = String(body.action ?? '').trim();
  const passcode = typeof body.passcode === 'string' ? body.passcode : '';
  const nickname = String(body.nickname ?? '').trim().slice(0, 24);

  try {
    /* --------- 首次初始化：设置小组口令 --------- */
    if (action === 'setup') {
      const envPass = Deno.env.get('SITE_PASSCODE') ?? '';
      const effectivePass = envPass || passcode;
      if (effectivePass.length < 4) return fail('口令至少 4 位', 400);
      if (!nickname) return fail('请填写你的昵称', 400);

      const salt = newSalt();
      const hash = await hashPasscode(effectivePass, salt);
      const outcome = await mutate(store, (doc) => {
        if (doc.settings.passcodeHash) {
          return { abort: { status: 409, message: '站点已经初始化过了，请直接用口令登录' } };
        }
        doc.settings.passcodeSalt = salt;
        doc.settings.passcodeHash = hash;
        doc.settings.initializedAt = new Date().toISOString();
        doc.members = [{ nickname, joinedAt: new Date().toISOString() }];
        return { extra: { nickname } };
      });
      return json({
        ok: true,
        token: await signSession({ nickname }),
        nickname,
        revision: outcome.revision,
        usedEnvPasscode: Boolean(envPass),
      });
    }

    /* --------- 第一次进来：报口令 + 昵称 --------- */
    if (action === 'intro') {
      if (!nickname) return fail('请填写你的昵称', 400);
      const outcome = await mutate(store, (doc) => {
        const settings = doc.settings as Record<string, string>;
        if (!settings.passcodeHash) {
          return { abort: { status: 428, message: '站点还没有初始化，请先设置一个口令', extra: { needSetup: true } } };
        }
        return { extra: { salt: settings.passcodeSalt, hash: settings.passcodeHash } };
      });
      const { salt, hash } = outcome.extra as { salt: string; hash: string };
      if (!(await verifyPasscode(passcode, salt, hash))) return fail('口令不正确', 401);

      const outcome2 = await mutate(store, (doc) => {
        const now = new Date().toISOString();
        const index = doc.members.findIndex((m) => m.nickname === nickname);
        if (index >= 0) doc.members[index] = { ...doc.members[index], lastSeenAt: now };
        else doc.members.push({ nickname, joinedAt: now });
        return { extra: { nickname } };
      });
      return json({ ok: true, token: await signSession({ nickname }), nickname, revision: outcome2.revision });
    }

    /* --------- 以后进来：口令，或直接选已有昵称 --------- */
    if (action === 'login') {
      const member = String(body.member ?? '').trim().slice(0, 24);
      const outcome = await mutate(store, (doc) => {
        const settings = doc.settings as Record<string, string>;
        if (!settings.passcodeHash) {
          return { abort: { status: 428, message: '站点还没有初始化', extra: { needSetup: true } } };
        }
        const known = member && doc.members.some((m) => m.nickname === member);
        if (!known) {
          if (!member) return { abort: { status: 400, message: '请选择或填写昵称' } };
          return { extra: { needPasscode: true, salt: settings.passcodeSalt, hash: settings.passcodeHash } };
        }
        return { extra: { known: true } };
      });

      if (outcome.extra.needPasscode) {
        const { salt, hash } = outcome.extra as { salt: string; hash: string };
        if (!(await verifyPasscode(passcode, salt, hash))) return fail('口令不正确', 401);
        await mutate(store, (doc) => {
          if (!doc.members.some((m) => m.nickname === member)) {
            doc.members.push({ nickname: member, joinedAt: new Date().toISOString() });
          }
          return {};
        });
      }
      return json({ ok: true, token: await signSession({ nickname: member }), nickname: member });
    }

    /* --------- 改口令 --------- */
    if (action === 'passcode') {
      const session = await currentSession(req);
      if (!session) return fail('请先登录', 401);
      const next = String(body.newPasscode ?? '');
      if (next.length < 4) return fail('新口令至少 4 位', 400);

      const probe = await mutate(store, (doc) => {
        const settings = doc.settings as Record<string, string>;
        return { extra: { salt: settings.passcodeSalt, hash: settings.passcodeHash } };
      });
      const { salt, hash } = probe.extra as { salt: string; hash: string };
      if (!(await verifyPasscode(passcode, salt, hash))) return fail('当前口令不正确', 401);

      const newS = newSalt();
      const newH = await hashPasscode(next, newS);
      await mutate(store, (doc) => {
        doc.settings.passcodeSalt = newS;
        doc.settings.passcodeHash = newH;
        return {};
      });
      return json({ ok: true, message: '口令已更新，其他人下次需要重新输入口令' });
    }

    if (action === 'logout') return json({ ok: true });
    return fail(`未知的 action：${action}`, 400);
  } catch (err) {
    const rejection = denied(err);
    if (rejection) return rejection;
    console.error('[auth]', err);
    return fail(`服务器错误：${(err as Error).message}`, 500);
  }
}

/* =============================== 数据接口 =============================== */

export async function dataRoute(req: Request, store: Store, url: URL): Promise<Response> {
  const session = await currentSession(req);
  if (!session) return fail('请先登录', 401);

  try {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const { doc, revision } = await store.readDoc();
      if (url.searchParams.get('probe') === '1') {
        const settings = (doc?.settings as Record<string, unknown>) ?? {};
        return json({ revision, updatedAt: (settings.updatedAt as string) ?? null });
      }
      return json({ revision, doc });
    }

    if (req.method !== 'PUT') return fail('不支持的请求方法', 405);

    const body = await readJsonBody(req);
    const incoming = body.doc;
    if (!incoming || typeof incoming !== 'object') return fail('缺少 doc 字段', 400);

    if (JSON.stringify(incoming).length > MAX_BYTES) {
      return fail('数据太大了（超过 8MB），请减少图片数量或压缩后再试', 413);
    }

    const baseRevision = Number((body.baseRevision ?? body.revision ?? 0) as number) || 0;
    const { doc: currentRaw, revision: serverRevision } = await store.readDoc();
    const current = normalizeDoc(currentRaw);

    // 乐观锁：允许落后 2 个版本以内（同一用户多标签页），明显过期就让前端先同步
    const behind = serverRevision - baseRevision;
    if (behind > 2 || baseRevision > serverRevision) {
      return json({
        error: '数据已被其他人修改，请先同步最新内容',
        conflict: true,
        revision: serverRevision,
        doc: current,
      }, 409);
    }

    const doc = incoming as Record<string, unknown>;
    // 口令哈希 / 成员名单只能由服务端写，客户端覆盖不了
    const settings = { ...((doc.settings as Record<string, unknown>) ?? {}) };
    const currentSettings = current.settings as Record<string, unknown>;
    for (const key of ['passcodeHash', 'passcodeSalt', 'initializedAt']) {
      if (currentSettings[key] !== undefined) settings[key] = currentSettings[key];
    }
    doc.settings = settings;
    if (current.members.length) doc.members = current.members;
    doc.updatedAt = new Date().toISOString();

    const revision = await store.writeDoc(doc, serverRevision);
    return json({ ok: true, revision, updatedAt: doc.updatedAt });
  } catch (err) {
    if (err instanceof ConflictError || (err as { statusCode?: number }).statusCode === 409) {
      const latest = await store.readDoc();
      return json({
        error: '数据已被其他人修改，请先同步',
        conflict: true,
        revision: latest.revision,
        doc: normalizeDoc(latest.doc),
      }, 409);
    }
    console.error('[data]', err);
    return fail(`服务器错误：${(err as Error).message}`, 500);
  }
}

/* =============================== 自检接口 =============================== */

export async function healthRoute(store: Store): Promise<Response> {
  const report: Record<string, unknown> = {
    ok: false,
    time: new Date().toISOString(),
    runtime: `deno ${Deno.version.deno}`,
    platform: Deno.env.get('DENO_DEPLOYMENT_ID') ? 'deno-deploy' : 'local',
    appSecretConfigured: Boolean(Deno.env.get('APP_SECRET')),
    sitePasscodeConfigured: Boolean(Deno.env.get('SITE_PASSCODE')),
  };
  try {
    const health = await store.health();
    const { revision } = await store.readDoc();
    report.ok = health.ok;
    report.storage = health;
    report.revision = revision;
  } catch (err) {
    report.error = (err as Error).message;
    report.hint = 'Deno Deploy 自带 KV，一般不需要额外配置；本地请确认 DATA_FILE 所在目录可写。';
  }
  return json(report, report.ok ? 200 : 500);
}
