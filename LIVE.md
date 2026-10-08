# 线上部署与运维手册

> 最后更新：2026-10-08

## 站点信息

| 项目 | 值 |
| --- | --- |
| 网址 | https://homework-site.goosepromax.deno.net |
| 小组口令 | `0304`（可在网站「⚙ 设置」里自行修改） |
| 平台 | Deno Deploy（新版，`console.deno.com`） |
| 组织 / 应用 | `GooseProMax` / `homework-site` |
| 代码仓库 | https://github.com/GooseProMax/homework-site |
| 数据库 | Deno KV，实例 `hw-data`（按环境自动分 production / preview / local 三个库） |
| 自动部署 | 推送到 GitHub `main` 分支后，Deno Deploy 自动构建上线（约 1 分钟） |

## 一个必须知道的坑：`github.com` 在国内被墙

- `github.com` 解析到 `20.205.243.166`，**这个 IP 被单独阻断**，所以 `git push` 永远超时（挂梯子才行）。
- `api.github.com`（`20.205.243.168`）**国内可直连**，所以我们改用 **GitHub REST API** 提交代码。

### 更新线上代码的正确姿势（不需要梯子）

```powershell
cd "C:\Users\20450\Desktop\作业云服务器\homework-site"
node scripts\push-via-api.js
```

脚本会：对比远端树 → 只上传有变化的文件 → 通过 API 建立 commit → 更新 `main` 分支。

第一次使用需要一个 **Fine-grained personal access token**：

1. https://github.com/settings/personal-access-tokens/new
2. Repository access → Only select repositories → `homework-site`
3. Permissions → Contents → **Read and write**
4. 生成后**别贴到聊天里**，脚本运行时会用隐藏输入的方式读取

> 注意：API 提交不会同步本地 `git` 历史，本地和远端会逐渐分叉。这是刻意的取舍 ——
> 发布以「本地文件内容」为准，每次对比文件内容推送，不依赖 git 历史。

## 常用脚本

| 脚本 | 用途 |
| --- | --- |
| `node tests/accept-live.js` | 线上验收：静态资源 + 接口鉴权 + 页面完整性 + 国内延迟（22 项） |
| `node tests/live-maintain.js status` | 查看线上市集状态（口令是否设置、成员名单、revision） |
| `node tests/live-maintain.js passcode <旧> <新>` | 修改小组口令 |
| `node tests/live-maintain.js verify <口令>` | 验证数据真的写进了 Deno KV（写入 → 等待 → 重读） |
| `node tests/verify-login-bypass.js` | 验证「必须凭口令登录」的安全约束 |
| `node tests/finalize.js` | 清理测试账号、打印站点最终状态 |
| `node scripts/show-schedule.js` | 打印线上课程表和作业清单 |
| `node scripts/render-timetable.js` | 把课程表渲染成「星期 × 节次」的文本表格 |
| `node scripts/import-schedule.js` | 批量导入课表（脚本里改课程数组） |
| `node scripts/merge-courses.js` | 合并重复课程（把作业一并转过去） |
| `.tools\bin\deno.exe run -A tests\deno-tests.ts` | 本地全量测试（36 项，覆盖接口与静态资源） |
| `node tests/api-tests.js` / `ui-tests.js` / `html-check.js` | Node 版接口测试 46 项 / 前端逻辑 44 项 / HTML 体检 12 项 |

## 本地开发

```powershell
# Deno 版（和线上同一套代码）
.tools\bin\deno.exe run -A server.ts          # → http://localhost:8000
# Node 版（备用，Vercel 那套代码）
node server/dev-server.js                     # → http://127.0.0.1:5173
```

改完前端（`index.html` / `styles.css` / `js/*.js`）后要重新生成静态资源清单：

```powershell
.tools\bin\deno.exe task sync                 # 生成 src/static.ts（该文件不入库）
```

Deno Deploy 的 Build command 里也配了 `deno task sync`，所以线上构建时会自动生成；
仓库里不存生成文件（`.gitignore` 已排除），避免改前端忘记同步。

## 环境变量（Deno Deploy → 项目 → Settings → Environment Variables）

| 变量 | 值 | 说明 |
| --- | --- | --- |
| `APP_SECRET` | 一串随机长字符 | 登录令牌签名密钥。**不配的话每次冷启动都会让所有人掉线** |
| `SITE_PASSCODE` | （可选，未配） | 预设小组口令；配了之后口令由环境变量决定，网页上不能再改 |

## 架构速览

```
浏览器（纯静态，零依赖）
  └─ /api/auth    登录、初始化、改口令、成员管理
  └─ /api/data    读取 / 保存（乐观锁 + 冲突自动合并）
  └─ /api/health  自检（数据库、密钥、平台）
       └─ 存储层：Deno KV（线上） / JSON 文件（本机）
```

- 静态页面（`index.html` / `styles.css` / `js/*.js`）由 `server.ts` 直接返回，不做构建打包。
- 口令用 PBKDF2-SHA256（10 万次迭代）哈希后存储，客户端无法覆盖；成员名单也只允许服务端改。
- 保存采用乐观锁：版本号落后超过 2 会被拒绝（409），前端按 `updatedAt` 合并两边改动。
- 图片在前端压缩（最长边 1600px、JPEG、约 320KB 以内）后以 data URL 存入同一条数据，单次保存上限 8MB。

## 已修复的历史问题（避免重复踩坑）

| 问题 | 原因 | 修复 |
| --- | --- | --- |
| 设置口令后页面回到开头 | 表单 submit 事件绑定晚于用户点击，浏览器原生提交导致刷新 | 事件改为脚本加载时立即绑定 + HTML `onsubmit="return false"` 兜底 |
| 知道昵称就能免口令进入 | `login` 动作对已有成员跳过口令校验 | 所有登录路径统一强制校验口令 |
| 客户端能改口令哈希 | `PUT /api/data` 直接接受客户端传入的 settings | 服务端保留 `passcodeHash` / `passcodeSalt` / `members`，客户端覆盖无效 |
| 中文目录下 Deno 找不到文件 | `URL.pathname` 把目录名百分号编码 | 改用 file URL / `decodeURIComponent` |
| PowerShell 脚本报语法错 | PS 5.1 把无 BOM 的 UTF-8 当 GBK 读 | 所有 `.ps1` 脚本保持纯 ASCII |
