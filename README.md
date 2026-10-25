# 高潜作业 · 学情看板

把 MarsOJ 上「高潜」作业的完成情况、**每一次提交**、课堂节奏和知识点证据，汇总成一个可交互的看板。
这个版本不是「更多图表」，而是把数据底座从「成绩表里每格一条选中记录」换成「全量提交流 + 课程蓝图」，
让每条学情结论都能追到具体提交。

## 启动

```bash
# 首次：从课程资料抽取蓝图（已提交 blueprint/，只有课程资料更新时才需要重跑）
npm run blueprint

# 抓取 + 诊断（约 10–20 分钟，取决于平台接口速度）
npm run scrape

# 启动本地看板
npm start

# 校验
npm test          # 纯函数单测
npm run verify    # 数据 + 诊断一致性检查
```

打开 <http://127.0.0.1:43130>，在「学情诊断」页查看课次诊断。

平台的全量提交流接口较慢（越深的页越慢），`npm run scrape` 默认按 12 分钟预算抓取并在 `data/raw/submissions.partial.json` 断点续抓；未抓完的题会在诊断页顶部标「数据未完整」，再次运行会继续。GitHub Actions 用 `data/raw` 缓存跨天累积。

Windows 下也可以双击 `启动看板.bat`（只启动，不抓取）。

## 学情诊断怎么算

诊断只覆盖 **4 名有效学员 × 5 次课**（9/12、9/19、9/26、10/17、10/24）。王丹丹为教师、刘宸玺为新学员，已排除出统计口径。

- **完成情况**：正式题最终 AC 数 / 20；拆成课内完成、课后补做、提交未通过、未做。
- **掌握（对齐课程验收）**：一次通过率 = 首次有效提交即 AC 的正式题数 / 有记录正式题数。
  另对照课程自己的验收标准（4 题检测、课内 16/20、小测 80 分）。
- **学习状态**：每题实际用时 / 教案建议时长（节奏）、重试与放弃（坚持）、当堂活跃时段与中断（投入）、超前与补做。
- **知识点**：题目 → 双评知识点 → 按知识点聚合首次通过率与覆盖。
- **独立性提示**：同题提交时间邻近 + AC 代码相似度，只作提示，不作抄袭结论。

「学情诊断」页末尾的「方法与证据缺口」列出所有定义、公式、内部验证（难度梯度一致性、分半信度、留出课次预测、敏感性分析）和数据缺口（小测、手算、教师提示未数字化）。

## 数据与目录

```
blueprint/blueprint.json   课次 → 题目 → 知识点 → 梯度 → 建议时长 → 验收标准（由课程资料抽取，已提交）
blueprint/sources.json     课程资料来源与 SHA-256（审计用）
data/snapshot.json         成绩表快照：每格选中的记录、代码、测试点
data/raw/submissions.json  全量提交流：每题每次提交的 status/uid/judgeAt（不提交）
data/diagnosis.json        诊断结果（静态构建时复制到 dist/diagnosis.json）
data/known-homeworks.json  新增作业基线
data/record-cache.json     记录缓存
public/                    页面与交互
scripts/extract-blueprint.mjs  课程资料 → 蓝图
scripts/scrape-raw.mjs         全量提交流抓取（断点续抓）
scripts/analyze.mjs            蓝图 + 快照 + 提交流 → 诊断
scripts/verify.mjs             数据与诊断一致性检查
tests/analytics.test.mjs       纯函数单测
```

`data/` 已加入 `.gitignore`，学员数据不会提交到 GitHub。`blueprint/` 会提交，因为 GitHub Actions 访问不到本地课程资料目录。

## 配置

首次运行复制 `.env.example` 为 `.env`，填入 MarsOJ 账号：

```powershell
Copy-Item .env.example .env
notepad .env
```

`.env` 已被 `.gitignore` 排除。也可以直接用环境变量：

```powershell
$env:MARS_USER="你的账号"
$env:MARS_PASS="你的密码"
$env:PORT="43130"
node server.mjs
```

可调参数：

- `MARS_CONCURRENCY`：抓取并发数，默认 `6`（平台接口较慢，过高会被拖慢）。
- `RAW_BUDGET_MS`：全量提交流抓取的时间预算，默认 12 分钟；未完成的问题会标记 `pending`，下次运行从检查点继续。
- `AUTO_CHECK_MS`：自动检测新作业的间隔，默认 `300000`（5 分钟）；设为 `0` 可关闭。

## 部署到 GitHub Pages

公开版使用 **GitHub Actions 每天 00:00（北京时间）自动抓取 + 静态展示**。Pages 不能运行 Node 服务，所以页面只读取最近一次发布的数据。

1. 仓库 **Settings → Secrets and variables → Actions** 中添加 `MARS_USER`、`MARS_PASS`。
2. **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
3. 推送后到 **Actions → Deploy dashboard → Run workflow** 手动运行一次；首次抓取约 2–3 分钟，加上全量提交流约 10–20 分钟。
4. 之后每天北京时间 00:00 自动更新；工作流文件为 `.github/workflows/pages.yml`。

> 公开页面会展示真实姓名、成绩、提交代码与诊断结论（当前配置），并已添加 `noindex` / `robots.txt` 禁止搜索引擎收录。请只在可信范围内分享链接。

## 口径与局限

- 平台只提供 `judgeAt`（评测时间），没有 `submitAt`；时间差通常在数秒内，对分钟级节奏分析影响可忽略。
- 全量提交流接口按记录 id 分页，越深的页越慢；抓取按时间预算断点续抓，诊断页会显示覆盖率与 `pending` 情况。
- 小测、手算口述、教师提示与本地冻结测试尚未数字化；「掌握」结论只覆盖 OJ 可观测部分。
- 当堂/课后按北京时间 09:00–16:30 划分；上午讲授、下午练习的实际切换点未逐课记录，时间分布只作描述。
- 样本量小（4 人 × 5 课），所有比例都是描述性证据，不做显著性排名或总体推断。

## 说明

- 看板只读取 MarsOJ 中当前账号有权限访问的作业与学员数据。
- 若学员端登录失效，抓取会自动重新登录一次；连续失败会在页面提示。
- GitHub Actions 的抓取凭据只存放在仓库 Secrets 中，不会出现在代码或日志里。
