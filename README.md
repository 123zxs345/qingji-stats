# 轻记 · 数字统计

手机端优先的极简统计网页：连续录入 1—50 的编号，自动统计**出现次数**或**累计数量**。免构建、可离线、可同步到 TinyWebDB、可发布到 GitHub Pages。

需求与验收标准见 [实施计划](../../docs/superpowers/plans/2026-10-12-wechat-stats-demo.md)。

## 直接打开

双击 `index.html` 即可使用，不需要 Node、不需要联网、不需要账号。录入的数据保存在当前浏览器；云端未配置时只保存到本机。

## 两种模式

| 模式 | 输入 | 结果 |
| --- | --- | --- |
| 次数统计 | `1 2 1 50` | `1（2）、2（1）、50（1）` |
| 数量累加 | `1(100) 2(50)`，再录 `1(88) 2(896)` | `1（188）、2（946）` |

规则：

- 编号 1—50，数量是大于 0 的整数；一条数据里出现任何非法内容就**整条拒收**，不会写进本机存档。
- 两种模式各有独立批次，切换模式不换算、不删除。
- 撤销是**追加一条撤销事件**，不删除云端记录；撤销后刷新仍然有效。
- 编号相同的数据会自动合并，例如 `1（2）` 表示 1 号出现 2 次。

## 开发与验证

本目录本身就是一个独立的 git 仓库（分支 `main`），发布到 GitHub Pages 时以本目录为仓库根。下面的命令可以在本目录里直接运行；如果你想从项目根目录 `E:\微信小程序` 运行，把 `node ` 后面的路径换成 `sites/wechat-stats-demo/…`。

```powershell
# 计算与云端同步的单元测试（Node 内置测试，无需安装依赖）
node --test tests/*.test.mjs

# 浏览器行为检查：375 / 390 像素布局、录入→汇总、刷新持久化、撤销、同步幂等、断网回退
node scripts/check-browser.mjs

# 检查构建产物本身（而不只是源码目录）
$env:CHECK_ROOT = "$PWD/dist"; node scripts/check-browser.mjs; Remove-Item Env:CHECK_ROOT

# 本机预览（仅监听 127.0.0.1:4176）
node scripts/preview.mjs

# 静态导出到 dist/
node scripts/build.mjs
```

浏览器检查需要 Playwright（项目根目录的 `node_modules` 已包含），优先使用本机已安装的 Chrome，没有时退回 Playwright 自带 Chromium；截图输出到 `docs/screenshots/stats-demo-375.png` 和 `stats-demo-390.png`。它不依赖 `node --test`，因为在受限环境里测试子进程的管道会让浏览器启动卡住。

## 云端同步

同步使用独立的 `wxstat_demo_v1_` 标签前缀，与其它项目的数据互不干扰；没有登录密码或 API 密钥的源码副本一律不能提交。

- 源码里的 `config.js` **只允许**存在不含账号的本地开发配置，`scripts/build.mjs` 在导出前会校验这一条。
- 构建产物 `dist/config.js` 才包含数据库账号与密钥，由构建时注入，`dist/` 已在 `.gitignore` 中。
- GitHub 仓库需要在 Settings → Secrets and variables → Actions → **Variables** 配置 `TINYWEBDB_USER` 与 `TINYWEBDB_KEY`，工作流在构建时注入；不要把登录密码写进任何文件。
- 使用已有 TinyWebDB 账号配一个**新的标签前缀**即可；同一账号下的不同前缀互不影响。

同步的两个行为约定（都是为了保证同步永远不会卡在「核对失败」）：

- 云端只保存录入与撤销事件、批次信息和一条当前批次记录；已写下的事件不会被改写。
- 「当前批次」是**推导值**而不是存下来的指针：当前批次 = 活动时间最新的那批。所以手动切回一个更早的批次后，刷新或同步会回到活动时间最新的那一批；正在录入的那一批永远会保留。

真实数据库验证（会在临时命名空间里完整走一遍写入、恢复、幂等、撤销、新建批次，最后清理干净）：

```powershell
$env:TINYWEBDB_USER='账号'; $env:TINYWEBDB_KEY='密钥'
node scripts/verify-live-cloud.mjs
```

本机直连 `tinywebdb.appinventor.space` 不稳定，必要时让 Node 走本机代理：

```powershell
$env:NODE_USE_ENV_PROXY='1'; $env:HTTPS_PROXY='http://127.0.0.1:端口'
```

## 目录结构

| 文件 | 用途 |
| --- | --- |
| `core.mjs` | 严格解析、两种模式、批次、撤销、汇总与备份校验 |
| `tinywebdb.mjs` | 云端事件的读写、合并、幂等核对与当前批次指针 |
| `app.mjs` | 界面交互、本机存档、同步调度 |
| `index.html` / `styles.css` / `icon.svg` | 界面与图标 |
| `config.js` | 本地开发配置（不含账号） |
| `scripts/build.mjs` | 静态导出与公开数据库配置 |
| `scripts/preview.mjs` | 仅本机回环地址的预览服务 |
| `scripts/check-browser.mjs` | 手机宽度与关键流程的浏览器检查 |
| `scripts/verify-live-cloud.mjs` | 真实 TinyWebDB 读写验证与清理 |
| `.github/workflows/pages.yml` | 独立仓库的 Pages 发布工作流 |
