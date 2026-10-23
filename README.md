# 高潜作业 · 学情看板

把 MarsOJ 上所有“高潜”作业的学员完成情况、逐题状态和做题记录，汇总成一个可交互的可视化看板。

## 启动

```bash
node server.mjs
```

Windows 下也可以直接双击 `启动看板.bat`。

打开 <http://127.0.0.1:43130>。

也可以使用：

```bash
npm start
```

## 使用

1. 打开页面后，点击右上角 **抓取最新数据**。
2. 系统会依次：
   - 登录管理端 `manager.marsoj.cn`；
   - 检索标题中包含“高潜”的作业（支持 `高潜001`、`山东高潜01` 等命名）；
   - 读取每次作业的题目、成绩表和学员名单；
   - 登录学员端 `marsoj.cn`，逐条抓取每位学员每道题的评测记录与代码；
   - 写入 `data/snapshot.json`，页面自动刷新。
3. 抓取过程中会显示进度。首次抓取约 2–3 分钟（取决于记录数量），再次抓取会重新拉取最新记录。

## 页面功能

- **总览**：作业数、学员数、题目数、提交记录、平均完成率；作业趋势、题目状态分布、学员 × 作业完成热力图、学员排行。
- **作业分析**：单次作业的学员排名、逐题完成矩阵、逐题 AC 率与难度。
- **学员画像**：每位学员的整体完成率、各次作业完成率雷达图、逐题状态、最近提交。
- **提交记录**：按作业 / 学员 / 状态筛选，分页查看全部记录；点击任意记录查看代码、评测详情和测试点。
- **导出**：提交记录页支持导出当前筛选结果为 CSV。
- **新增作业检测**：服务端每 5 分钟自动检索一次新作业；页面打开时也会立即检测。发现新作业后顶部会出现提示，抓取后自动加入看板并标记“新增”。

## 数据与配置

- `data/snapshot.json`：最近一次抓取的完整快照（页面读取此文件）。
- `data/known-homeworks.json`：已发现的作业基线，用于判断“新增”。
- `data/record-cache.json`：做题记录缓存，便于重复抓取时加速。

项目不再内置账号密码。首次运行请复制 `.env.example` 为 `.env`，填入 MarsOJ 账号：

```powershell
Copy-Item .env.example .env
notepad .env
```

`.env` 已被 `.gitignore` 排除，不会提交到 GitHub。也可以直接用环境变量：

```powershell
$env:MARS_USER="你的账号"
$env:MARS_PASS="你的密码"
$env:PORT="43130"
node server.mjs
```

其他可调参数：

- `MARS_CONCURRENCY`：做题记录抓取并发数，默认 `6`。
- `AUTO_CHECK_MS`：自动检测新作业的间隔，默认 `300000`（5 分钟）；设为 `0` 可关闭。

## 部署到 GitHub Pages（公开访问）

公开版使用 **GitHub Actions 每天 00:00（北京时间）自动抓取 + GitHub Pages 静态展示**。GitHub Pages 不能运行 Node 服务，所以公开页面的“刷新页面数据”只加载最近一次发布的数据，真正抓取由 Actions 完成。

1. 在 GitHub 新建一个空仓库（建议 Public，免费 Pages 不需要额外套餐），不要勾选初始化 README。
2. 进入仓库 **Settings → Secrets and variables → Actions → New repository secret**，添加：
   - `MARS_USER`：MarsOJ 账号
   - `MARS_PASS`：MarsOJ 密码
3. 进入 **Settings → Pages → Build and deployment → Source**，选择 **GitHub Actions**。
4. 在本项目目录关联并推送仓库：

   ```powershell
   git remote add origin https://github.com/<你的用户名>/<仓库名>.git
   git branch -M main
   git push -u origin main
   ```

5. 打开仓库 **Actions → Deploy dashboard → Run workflow**，手动运行一次；首次抓取约 2–3 分钟。
6. 运行完成后，在 **Settings → Pages** 或 Actions 的部署记录中查看网址，通常为：

   ```text
   https://<你的用户名>.github.io/<仓库名>/
   ```

之后每天北京时间 00:00 自动更新；也可以随时到 Actions 页面手动运行。工作流文件为 `.github/workflows/pages.yml`。更细的逐步清单见 [GITHUB_DEPLOY.md](GITHUB_DEPLOY.md)。

> 公开页面会展示真实学员姓名、成绩和提交代码（当前配置），并已添加 `noindex` / `robots.txt` 禁止搜索引擎收录。请只在可信范围内分享链接。

## 目录

```
server.mjs              本地服务：静态页面、抓取 API、SSE 进度、定时检测
scraper.mjs             登录、检索作业、成绩表解析、记录抓取与解析
run-scrape.mjs          命令行抓取入口
scripts/build-static.mjs 生成 GitHub Pages 静态发布目录 dist/
.github/workflows/pages.yml 每天 00:00（北京时间）抓取并部署 Pages
public/index.html       页面结构
public/styles.css       视觉样式
public/app.js           交互、图表、筛选、详情抽屉
public/vendor/          本地 ECharts
data/                   抓取结果与基线
```

## 说明

- 本地数据保存在 `data/`，已加入 `.gitignore`，不会提交到 GitHub。
- 公开页面会展示真实姓名、成绩和代码（当前配置）；已添加 noindex/robots 禁止搜索引擎收录，请谨慎分享链接。
- 看板只读取 MarsOJ 中当前账号有权限访问的作业与学员数据。
- 若学员端登录失效，抓取会自动重新登录一次；连续失败会在页面提示。
- GitHub Actions 的抓取凭据只存放在仓库 Secrets 中，不会出现在代码或日志里。
