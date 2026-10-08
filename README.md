# 作业云服务器 📚

一个给小组/班级用的**共享作业板**：

- **16 周分开记**：从第 1 周到第 16 周，一周一张卡片，本周自动高亮。
- **每周每节课的作业**：作业按课程归到对应周次，每门课一种颜色。
- **大作业单独标识**：大作业（和考试）用橙色单独拉一栏展示，也可以直接排在某周里。
- **课表自己录**：网页上点「🗓 课表」就能增删课程（名称/老师/教室/星期/节次/颜色），自动排出课程表网格。
- **每个人都能上传**：输入小组口令 + 昵称即可上传内容、贴图（截图自动压缩）、勾选自己是否完成，所有人看到同一份数据。
- **免费部署**：前端静态页面 + 2 个 Serverless 接口，可以直接部署到 Vercel 免费版。

---

## 一、先在本机跑起来看看（30 秒）

需要 Node.js 18 以上（本机验证用的是 v24）。

```powershell
cd "C:\Users\20450\Desktop\作业云服务器\homework-site"
node server/dev-server.js
```

然后浏览器打开 **http://127.0.0.1:5173** 。

第一次进入时它会让你**设置一个口令**（至少 4 位，随便定，比如 `hw2025`），再填自己的昵称。
本机开发默认把数据存到 `.local-data/data.json`，不需要装任何东西、不需要数据库。

> 想验证接口是否正常：打开 http://127.0.0.1:5173/api/health
> 想跑自动化测试：`node tests/api-tests.js`、`node tests/ui-tests.js`、`node tests/html-check.js`
> （浏览器还开着本机服务时，可以再跑 `node tests/smoke-live.js` 走一遍真实请求链路）
> 四套加起来 109 项检查，全部通过。

> ⚠️ 注意：本机这份数据在验证时已经被初始化过，**当前口令是 `hw2025`（昵称「我」）**，
> 里面还留了两门示例课程和 3 条示例作业方便你看效果。
> 想从零开始：删掉 `homework-site/.local-data/data.json` 再刷新页面即可重新设置口令。

---

## 二、部署到 Vercel（免费，约 5 分钟）

### 1. 把代码传上 GitHub

```powershell
cd "C:\Users\20450\Desktop\作业云服务器\homework-site"
git init
git add .
git commit -m "作业云服务器：16 周作业板"
git branch -M main
git remote add origin https://github.com/你的用户名/homework-site.git
git push -u origin main
```

（仓库设为 Private 更稳妥，Vercel 一样能部署。）

### 2. 在 Vercel 导入这个仓库

1. 打开 https://vercel.com → 用 GitHub 账号登录 → **Add New… → Project**。
2. 选中刚才的仓库 → Framework Preset 选 **Other** → 其余不用改（本项目零依赖，不需要 Build Command）→ **Deploy**。
3. 部署完会给你一个网址，类似 `https://homework-site-xxx.vercel.app`。

### 3. 加一个免费数据库（存作业数据）

Vercel 的服务器不能写文件，数据必须放数据库。两种都免费、都零依赖：

**方案 A：Upstash Redis（最省事，推荐）**

1. Vercel 项目页 → **Storage** → **Create Database** → 选 **Upstash Redis**（免费档）→ 连接到本项目。
2. 连接后 Vercel 会自动往项目里注入 `KV_REST_API_URL` 和 `KV_REST_API_TOKEN`，**不用手抄**。
3. 回到 **Deployments** 最新一条 → **Redeploy**（让环境变量生效）。

**方案 B：Postgres（Neon / Supabase / Vercel Postgres）**

1. 任意一家建一个免费 Postgres，复制连接串（形如 `postgresql://user:pass@host/db?sslmode=require`）。
2. Vercel 项目 → **Settings → Environment Variables** → 新增 `DATABASE_URL` = 上面那串。
3. **Redeploy**。表结构会在第一次访问时自动创建，不用手动执行 SQL。

### 4. 再加两个环境变量

在 **Settings → Environment Variables** 里加：

| 变量名 | 值 | 作用 |
| --- | --- | --- |
| `APP_SECRET` | 随便一串长随机字符（32 位以上） | 登录令牌签名密钥。**不加的话每次冷启动所有人都会掉线** |
| `SITE_PASSCODE` | 例如 `hw2025` | 可选。预设小组口令，不用再在网页上设置 |

加完 **Redeploy**，然后打开 `https://你的域名/api/health` 自检，看到 `"ok": true` 就成了。

### 5. 通知同学

把网址和口令发到群里，大家打开 → 输入口令 → 填昵称 → 就能一起编辑了。
每个人的完成状态是分开记的（一条作业可以显示「✓ 小张 ✓ 小李」）。

---

## 三、日常怎么用

| 我想… | 怎么做 |
| --- | --- |
| 录课表 | 右上角 **🗓 课表** → 加课程，填星期和节次就能排出课程表 |
| 加本周作业 | 某张周卡片右上角的 **＋**，或直接按快捷键 **N** |
| 加大作业 | 右上角 **★ 大作业**，类型选「大作业」，它会用橙色单独展示 |
| 贴截图/照片 | 编辑框里点「选择图片」或直接 **Ctrl+V** 粘贴，自动压缩到几百 KB |
| 标记完成 | 点作业前面的方框（只影响你自己的完成状态） |
| 找作业 | 顶栏搜索框（快捷键 **/**），或左侧按课程/状态筛选 |
| 看总进度 | 左侧「进度」显示我完成了多少条、有几条逾期 |
| 撤销手滑 | **Ctrl+Z** / **Ctrl+Shift+Z**，或顶栏 ↺ ↻ |
| 备份 | 左侧「导出备份」下载 JSON；「导入备份」可以合并或覆盖 |
| 改口令 / 换周数 | 右上角 **⚙ 设置**（标题、学期名、16~20 周、开学日期、口令都能改） |

三种视图：**16 周总览**（默认，一周一张卡）、**清单模式**（按周纵向列表，适合手机上翻）、**课程表**（星期 × 节次的网格 + 课程卡片）。

---

## 四、项目结构

```
homework-site/
├─ index.html              # 页面骨架（登录页 + 主界面 + 弹窗）
├─ styles.css              # 全部样式
├─ js/
│  ├─ util.js              # 工具：DOM、日期、配色、图片压缩、提示条
│  ├─ api.js               # 后端通信（自动降级为本地模式）
│  ├─ store.js             # 数据仓库：增删改、撤销重做、自动保存、轮询同步、冲突合并
│  ├─ render.js            # 渲染：16 周网格 / 清单 / 课程表 / 侧栏
│  ├─ modals.js            # 弹窗：作业编辑、课表编辑、设置、确认框
│  └─ app.js               # 入口：登录闸门、事件绑定、快捷键
├─ api/                    # Vercel Serverless 函数（零第三方依赖）
│  ├─ auth.js              #   登录 / 初始化 / 改口令
│  ├─ data.js              #   读取 / 保存（乐观锁 + 冲突合并）
│  ├─ health.js            #   /api/health 自检
│  └─ _lib/
│     ├─ http.js           #   口令哈希（PBKDF2）、HMAC 令牌、JSON 响应
│     ├─ store.js          #   存储适配层：Postgres / Upstash Redis / 本地文件
│     └─ pg.js             #   自带的极简 PostgreSQL 客户端（node:tls + SCRAM-SHA-256）
├─ server/dev-server.js    # 本地开发服务器（静态文件 + /api 路由 + .env.local）
└─ tests/
   ├─ api-tests.js         # 接口端到端测试（45 项）
   └─ ui-tests.js          # 前端逻辑 + 静态检查（42 项）
```

---

## 五、常见问题

**Q：页面上出现「本地模式」黄条？**
A：说明浏览器连不上后端。本机运行时是正常的（没配数据库）；线上出现的话打开 `/api/health` 看报错，多半是 `DATABASE_URL` / `KV_REST_API_URL` 没配或没 Redeploy。

**Q：同学说「口令不对」？**
A：口令存在数据库里，第一位进站的人设置。忘了的话：Vercel 里加 `SITE_PASSCODE` 环境变量 → Redeploy，然后**用这个新口令进站**（进站后可在设置里再改一次口令写回数据库）。

**Q：数据会被别人覆盖吗？**
A：不会。保存走乐观锁：服务器版本和你手里的版本差太多会拒绝，并把最新数据返回，前端按 `updatedAt` 自动合并（对方新增的条目和你的改动都会保留，并提示「已自动合并」）。口令哈希和成员名单只能由服务器写，客户端改不动。

**Q：图片存在哪？会不会太大？**
A：图片在前端压缩（最长边 1600px、JPEG、约 320KB 以内）后以 data URL 存在同一条数据里。单次保存上限 8MB，超过会被拒绝。一个学期几十张截图完全够用；实在很多建议建个群相册放原图，只把关键截图放进作业说明。

**Q：手机上能用吗？**
A：能，页面自适应。手机浏览器菜单里「添加到主屏幕」后就像一个 App。

**Q：想换成 Postgres 的官方驱动 / 加别的功能？**
A：`api/_lib/store.js` 里三种后端走同一套接口（`readDoc` / `writeDoc` / `health`），新增一种后端只需加一个类。
