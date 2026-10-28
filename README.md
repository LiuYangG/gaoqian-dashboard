# 高潜作业 · 学情看板

把 MarsOJ 上「高潜」作业的完成情况、**每一次提交**、课堂节奏和知识点证据，汇总成一个可交互的看板。
这个版本不是「更多图表」，而是把数据底座从「成绩表里每格一条选中记录」换成「全量提交流 + 课程蓝图」，
让每条学情结论都能追到具体提交。

## 启动

```bash
# 首次：从课程资料抽取蓝图（已提交 blueprint/，只有课程资料更新时才需要重跑）
npm run blueprint

# 抓取 + 诊断（增量约 1–2 分钟；首次全量约 3–5 分钟）
npm run scrape

# 启动本地看板
npm start

# 校验
npm test          # 纯函数单测
npm run verify    # 数据 + 诊断一致性检查
```

打开 <http://127.0.0.1:43130>，在「学情诊断」页查看课次诊断。Windows 下也可以双击 `启动看板.bat`（只启动，不抓取）。

平台新版接口较快：每日只读取「上次检查点之后」的新提交与新增记录详情，写回每节课文件并去重；首次运行会把历史提交补齐。GitHub Actions 用 `data/raw` 与 `data/record-cache.json` 缓存跨天累积。

## 学情诊断怎么算

诊断的学员和课次都是动态的：从成绩表自动识别学员（教师账号由 `config/roles.json` 排除，未开始的同学自动标记），从蓝图和成绩表自动识别课次。新增学员、新增作业后无需改页面。

- **完成情况**：正式题最终 AC 数 / 已纳入统计的正式题；拆成课内完成、课后补做、提交未通过、未做。
- **掌握（对齐课程验收）**：一次通过率 = 首次有效提交即 AC 的正式题数 / 有记录正式题数。
  另对照课程自己的验收标准（4 题检测、课内 16/20、小测 80 分）。
- **学习状态**：相邻首次提交间隔 / 教案建议时长（节奏）、重试与放弃（坚持）、当堂活跃时段与中断（投入）、超前与补做。
- **知识点**：题目 → 双评知识点 → 按知识点聚合首次通过率与覆盖。
- **独立性提示**：同题提交时间邻近 + AC 代码相似度，只作提示，不作抄袭结论。
- **本节课评价**：选中「学员 + 课次」后，给出一段教师视角的中文评价，说明完成、一次通过、节奏、知识点与当天提交情况，只写可核对的事实。

「学情诊断」页的学员按钮、课次按钮、逐课行都可以点击切换；页面末尾的「方法与验证」列出定义、公式、内部验证（难度梯度一致性、分半信度、留出课次预测、敏感性分析）。

## 数据与目录

```
blueprint/blueprint.json   课次 → 题目 → 知识点 → 梯度 → 建议时长 → 验收标准（动态扫描课程目录，已提交）
blueprint/sources.json     课程资料来源与 SHA-256（审计用）
config/sessions.json       课次日期/作业映射；新增课节可在这里补一行
config/roles.json          教师账号排除名单
data/snapshot.json         成绩表快照：每格选中的记录、代码、测试点
data/raw/lessons/L01.json  每节课全量提交流：每题每次提交的 status/uid/judgeAt（不提交）
data/raw/index.json        每节课抓取状态与记录数
data/diagnosis.json        诊断结果（静态构建时复制到 dist/diagnosis.json）
data/known-homeworks.json  新增作业基线
data/record-cache.json     记录缓存
public/                    页面与交互
scripts/extract-blueprint.mjs  课程资料 → 蓝图（自动发现新增课节）
scripts/scrape-raw.mjs         按课节抓全量提交流（覆盖旧文件、去重、续抓）
scripts/analyze.mjs            蓝图 + 快照 + 每节课提交流 → 诊断
scripts/verify.mjs             数据与诊断一致性检查
tests/analytics.test.mjs       纯函数单测
config/README.md               新增课节/学员的操作说明
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
- `RAW_BUDGET_MS`：每节课提交记录抓取的时间预算，默认 10 分钟；每日更新只读取上次检查点之后的新记录。
- `AUTO_CHECK_MS`：自动检测新作业的间隔，默认 `300000`（5 分钟）；设为 `0` 可关闭。

## 部署到 GitHub Pages

公开版使用 **GitHub Actions 每天 00:00（北京时间）自动抓取 + 静态展示**。Pages 不能运行 Node 服务，所以页面只读取最近一次发布的数据。

1. 仓库 **Settings → Secrets and variables → Actions** 中添加 `MARS_USER`、`MARS_PASS`。
2. **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
3. 推送后到 **Actions → Deploy dashboard → Run workflow** 手动运行一次；首次抓取约 3–5 分钟，之后每日增量约 1–2 分钟。
4. 之后每天北京时间 00:00 自动更新；工作流文件为 `.github/workflows/pages.yml`。

> 公开页面会展示真实姓名、成绩、提交代码与诊断结论（当前配置），并已添加 `noindex` / `robots.txt` 禁止搜索引擎收录。请只在可信范围内分享链接。

## 口径与局限

- 平台只提供 `judgeAt`（评测时间），没有 `submitAt`；时间差通常在数秒内，对分钟级节奏分析影响可忽略。
- 平台每节课的提交记录页按 20 条/页、从新到旧排列；每日增量抓取会读到上次检查点即停止。
- 记录详情（代码/提交时间/评测时间）按记录 ID 缓存，只有新出现的记录才会重新抓取。
- 新增课次/新增学员会自动纳入；历史课次文件按记录 ID 去重并覆盖。
- 小测、手算口述、教师提示与本地冻结测试尚未数字化；「掌握」结论只覆盖 OJ 可观测部分。
- 当堂/课后按北京时间 09:00–16:30 划分；上午讲授、下午练习的实际切换点未逐课记录，时间分布只作描述。
- 样本量小（4 人 × 5 课），所有比例都是描述性证据，不做显著性排名或总体推断。

## 说明

- 看板只读取 MarsOJ 中当前账号有权限访问的作业与学员数据。
- 若学员端登录失效，抓取会自动重新登录一次；连续失败会在页面提示。
- GitHub Actions 的抓取凭据只存放在仓库 Secrets 中，不会出现在代码或日志里。
