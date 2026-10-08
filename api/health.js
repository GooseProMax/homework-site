'use strict';

/**
 * GET /api/health  部署自检：数据库通不通、用的是哪种存储、密钥有没有配。
 * 打开 https://你的域名/api/health 就能看到结果，排错最有用。
 */

const { getStore } = require('./_lib/store');
const { sendJson, methodGuard } = require('./_lib/http');

module.exports = async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;
  const env = process.env;
  const report = {
    ok: false,
    time: new Date().toISOString(),
    runtime: `node ${process.version}`,
    env: env.VERCEL_ENV || 'local',
    appSecretConfigured: Boolean(env.APP_SECRET),
    sitePasscodeConfigured: Boolean(env.SITE_PASSCODE),
    dataFile: env.DATA_FILE || null,
  };

  try {
    const store = getStore();
    const health = await store.health();
    const { revision } = await store.readDoc();
    report.ok = Boolean(health.ok);
    report.storage = health;
    report.revision = revision;
    if (!env.APP_SECRET && env.VERCEL) {
      report.warning = '未配置 APP_SECRET：每次冷启动都会让所有人掉线，请在 Vercel 环境变量里加一个随机长字符串。';
    }
  } catch (err) {
    report.ok = false;
    report.error = err.message;
    report.hint =
      '检查 Vercel 环境变量：DATABASE_URL（Postgres 连接串）或 KV_REST_API_URL + KV_REST_API_TOKEN（Upstash Redis）。';
  }

  return sendJson(res, report.ok ? 200 : 500, report);
};
