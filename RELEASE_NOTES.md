# solgrid-canvas v0.2.1

0.2.0 之后的一轮修复与清理：Agent 会话生命周期、dev 模式连接，以及仓库瘦身。

## 修复

- **删除项目不再 500**：ACP 的 `session/close` 改用 request 发送并按协议等回执（之前发的是 notification，对端直接忽略），关闭会话后 Agent 侧的 MCP 子进程才会退出；删除项目前会先关闭该项目的所有会话。
- 项目目录仍被占用时返回 `409 project_busy` 并提示，而不是 `500 EPERM`。
- **Agent 进程退出可自愈**：进程退出后连接立即作废、挂起请求直接失败；下一次请求自动重新拉起 Agent，不再每个请求都卡满 120s 超时。

## 开发体验

- dev 模式的 Vite 代理按请求现读 `~/.solgrid-canvas/daemon.json` 的 token。daemon 重启换 token 后，不再需要手动同步 `web/.env.local`（该文件只作兜底）。

## 仓库清理

- 移除 GitHub Pages 与官方插件发布 workflow：本产品是本地 daemon + 浏览器，静态 Pages 无法工作；`plugins-dist` 分支产物没有任何消费者。
- 移除上游文档站 `docs/`（38 篇上游文档 + 独立 Next.js 站点）及 `.dockerignore` 中的相关条目。
- 删除远端 `plugins-dist` 分支；`upstream` remote 保留作参考。

## 升级说明

- daemon：重启 `npm start` / `npm run daemon`。
- Web：刷新页面即可；dev 模式无需再改 `.env.local`。

## 验证

- 新建项目 → 建对话 → prepare（deepseek-flash）→ 直接 DELETE：返回 200，目录已删除，会话清零。
- ACP 子进程退出后再次 prepare：45ms 完成（修复前会等满 120s）。
- 把 `.env.local` 的 token 改成错误值后，`/api/agent/status` 仍返回 200。
