# 部署到 GitHub Pages · 逐步清单

目标：得到一个所有人都能打开的公网网址，页面每天北京时间 00:00 自动更新。

> 当前配置会公开显示**真实学员姓名、成绩和提交代码**。页面已加 `noindex` 和 `robots.txt`，搜索引擎不会收录，但拿到链接的人都能看到。请只在可信范围内分享。

## 0. 前置条件

- [ ] 已注册并登录 GitHub：<https://github.com>
- [ ] 本机已安装 Git（本项目已验证可用）
- [ ] 已确认 MarsOJ 账号密码可用

## 1. 创建空仓库

- [ ] 打开 <https://github.com/new>
- [ ] Repository name 填一个名字，例如 `gaoqian-dashboard`
- [ ] 选择 **Public**（免费 Pages 不需要额外套餐）
- [ ] **不要**勾选 “Add a README file”
- [ ] 点击 **Create repository**
- [ ] 复制仓库地址，格式：`https://github.com/<你的用户名>/<仓库名>.git`

## 2. 配置 Actions 密钥

进入仓库 **Settings → Secrets and variables → Actions → New repository secret**，添加两条：

- [ ] `MARS_USER` = MarsOJ 账号
- [ ] `MARS_PASS` = MarsOJ 密码

注意：这两个值只保存在 GitHub Secrets，不会出现在代码里。

## 3. 开启 Pages

- [ ] 仓库 **Settings → Pages**
- [ ] **Build and deployment → Source** 选择 **GitHub Actions**

如果暂时找不到该选项，可以先完成第 4 步；工作流里的 `configure-pages` 会尝试自动开启。

## 4. 推送代码

在 PowerShell 中执行（把地址换成你的仓库地址）：

```powershell
cd "C:\Users\DELL\Desktop\高潜信息统计"
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

- [ ] 第一次推送时按提示登录 GitHub（浏览器授权或 Git Credential Manager）
- [ ] 推送成功后，仓库 **Actions** 页面会自动出现 `Deploy dashboard` 运行记录

## 5. 首次抓取与发布

- [ ] 打开仓库 **Actions → Deploy dashboard**
- [ ] 如果推送没有自动触发，点击 **Run workflow → Run workflow**
- [ ] 等待约 2–3 分钟（抓取 5 次作业、473 条记录）
- [ ] 两个 job 都变绿：`build` 和 `deploy`

如果 `build` 失败，优先检查：

- [ ] `MARS_USER` / `MARS_PASS` 是否拼写正确
- [ ] GitHub Actions 是否能访问 `marsoj.cn`、`ms.marsoj.cn`
- [ ] Actions 日志里是否提示 Pages 未开启

## 6. 获取公网网址

- [ ] 进入 **Settings → Pages**，或打开 `deploy` job 的输出
- [ ] 网址通常为：

```text
https://<你的用户名>.github.io/<仓库名>/
```

- [ ] 用手机/无痕窗口打开验证，确认无需登录即可访问

## 7. 日常更新

- [ ] 每天北京时间 **00:00** 自动抓取并发布
- [ ] 需要立即更新时：**Actions → Deploy dashboard → Run workflow**
- [ ] 公开页面的“刷新页面数据”按钮只重新加载最近一次发布的数据，不会直接触发抓取

## 常见问题

**Actions 里没有 Deploy dashboard**

确认 `.github/workflows/pages.yml` 已推送，且仓库默认分支是 `main`。

**Pages 404**

确认 Settings → Pages 的 Source 是 GitHub Actions，并等 deploy job 完成。

**抓取超时或登录失败**

先在本地运行 `node run-scrape.mjs` 验证账号；GitHub 托管机器在海外，访问 MarsOJ 可能较慢。若持续失败，需要改用 Render/Railway 等服务器方案。

**不想公开真实姓名/代码**

修改 `scripts/build-static.mjs`，在生成 `dist/data.json` 前对 `snapshot` 做匿名化处理，并删除 `records[].code`。当前版本没有启用匿名化。
