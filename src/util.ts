/**
 * 认证工具：口令哈希 + 会话令牌签名（全部用 WebCrypto，零依赖）。
 * 和 Node 版（api/_lib/http.js）行为一致，前端不用改。
 */

const encoder = new TextEncoder();

export function getSecret(): string {
  const secret = Deno.env.get('APP_SECRET') ?? Deno.env.get('SESSION_SECRET') ?? '';
  if (secret) return secret;
  // 没配 APP_SECRET 时给个固定值：功能正常，但重启后旧令牌依然有效（安全性略低）
  // Deno Deploy 上建议在项目设置里配 APP_SECRET。
  return 'homework-site-default-secret-please-set-APP_SECRET';
}

export function newSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** PBKDF2-SHA256，10 万次迭代 */
export async function hashPasscode(passcode: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(passcode), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: encoder.encode(salt), iterations: 100000, hash: 'SHA-256' },
    key,
    256,
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 定时安全比较，避免通过响应时间猜口令 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPasscode(passcode: string, salt: string, expectedHash: string): Promise<boolean> {
  if (!expectedHash || !salt) return false;
  const actual = await hashPasscode(passcode, salt);
  return timingSafeEqual(actual, expectedHash);
}

/* ------------------------------- 令牌 ------------------------------- */

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlEncode(text: string): string {
  return base64url(encoder.encode(text));
}

function base64urlDecode(text: string): string {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  return atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
}

async function hmac(data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(getSecret()), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return base64url(new Uint8Array(sig));
}

export interface Session {
  nickname: string;
  role: string;
  exp: number;
}

/** 90 天有效的签名令牌，格式和 Node 版一致 */
export async function signSession(payload: { nickname: string; role?: string }, ttlMs = 1000 * 60 * 60 * 24 * 90): Promise<string> {
  const body = { ...payload, role: payload.role ?? 'member', exp: Date.now() + ttlMs };
  const data = base64urlEncode(JSON.stringify(body));
  return `${data}.${await hmac(data)}`;
}

export async function verifySession(token: string | null): Promise<Session | null> {
  if (!token || !token.includes('.')) return null;
  const index = token.lastIndexOf('.');
  const data = token.slice(0, index);
  const mac = token.slice(index + 1);
  const expected = await hmac(data);
  if (!timingSafeEqual(mac, expected)) return null;
  try {
    const session = JSON.parse(base64urlDecode(data)) as Session;
    if (!session.exp || session.exp < Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

/* ------------------------------- HTTP ------------------------------- */

export function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

export function fail(message: string, status = 400, extra: Record<string, unknown> = {}): Response {
  return json({ error: message, ...extra }, status);
}

export function bearerToken(req: Request): string {
  const header = req.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

export async function currentSession(req: Request): Promise<Session | null> {
  return await verifySession(bearerToken(req));
}

export async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const text = await req.text();
    if (!text) return {};
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
