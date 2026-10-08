/* global window */
/* 与后端 /api 通信；手机上装成网页应用 / 用 file:// 打开时自动降级为本地模式 */
(function () {
  'use strict';

  const TOKEN_KEY = 'hw.token';
  const NICK_KEY = 'hw.nickname';

  const api = {
    token: '',
    nickname: '',
    offline: false, // true = 纯本地模式（数据只存在这台设备）
    lastError: '',
  };

  try {
    api.token = localStorage.getItem(TOKEN_KEY) || '';
    api.nickname = localStorage.getItem(NICK_KEY) || '';
  } catch (_) {
    /* 隐私模式下 localStorage 可能不可用 */
  }

  function saveSession(token, nickname) {
    api.token = token || '';
    if (nickname) api.nickname = nickname;
    try {
      if (api.token) localStorage.setItem(TOKEN_KEY, api.token);
      else localStorage.removeItem(TOKEN_KEY);
      if (api.nickname) localStorage.setItem(NICK_KEY, api.nickname);
    } catch (_) {
      /* ignore */
    }
  }

  function isFileProtocol() {
    return location.protocol === 'file:';
  }

  async function request(path, options) {
    const opts = options || {};
    const headers = Object.assign({}, opts.headers || {});
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (api.token && opts.auth !== false) headers.Authorization = `Bearer ${api.token}`;

    const response = await fetch(path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      cache: 'no-store',
    });

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (_) {
      payload = { error: text.slice(0, 300) };
    }

    if (response.status === 401 && opts.auth !== false) {
      saveSession('', api.nickname);
      api.lastError = (payload && payload.error) || '登录已失效';
      const error = new Error(api.lastError);
      error.status = 401;
      error.payload = payload;
      throw error;
    }
    if (!response.ok) {
      const error = new Error((payload && payload.error) || `请求失败（HTTP ${response.status}）`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  /** 探测后端是否可用；不可用则进入本地模式 */
  async function probe() {
    if (isFileProtocol()) {
      api.offline = true;
      return { offline: true, reason: 'file' };
    }
    try {
      const status = await request('/api/auth?action=status', { auth: false });
      api.offline = false;
      return Object.assign({ offline: false }, status);
    } catch (err) {
      api.offline = true;
      api.lastError = err.message;
      return { offline: true, reason: 'network', error: err.message };
    }
  }

  const client = {
    state: api,
    probe,
    saveSession,
    get nickname() { return api.nickname; },
    get offline() { return api.offline; },
    set nickname(value) { saveSession(api.token, value); },

    async status() {
      return request('/api/auth?action=status', { auth: false });
    },

    async setup(passcode, nickname) {
      const result = await request('/api/auth', { method: 'POST', auth: false, body: { action: 'setup', passcode, nickname } });
      saveSession(result.token, result.nickname || nickname);
      return result;
    },

    async intro(passcode, nickname) {
      const result = await request('/api/auth', { method: 'POST', auth: false, body: { action: 'intro', passcode, nickname } });
      saveSession(result.token, result.nickname || nickname);
      return result;
    },

    async login(passcode, member) {
      const result = await request('/api/auth', { method: 'POST', auth: false, body: { action: 'login', passcode, member } });
      saveSession(result.token, result.nickname || member);
      return result;
    },

    async changePasscode(passcode, newPasscode) {
      return request('/api/auth', { method: 'POST', body: { action: 'passcode', passcode, newPasscode } });
    },

    async load() {
      return request('/api/data');
    },

    async save(doc, baseRevision) {
      return request('/api/data', { method: 'PUT', body: { doc, baseRevision } });
    },

    async probeRevision() {
      return request('/api/data?probe=1');
    },

    async health() {
      return request('/api/health', { auth: false });
    },

    logout() {
      saveSession('', api.nickname);
    },
  };

  window.Api = client;
}());
