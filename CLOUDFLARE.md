# Cloudflare 分支维护与部署

本文件记录 `cloudflare` 分支的本地定制、上游同步和部署流程。后续更新或部署前先阅读本文件。

## 分支职责

- `main`：始终与 `origin/main` 保持一致，不放本地部署修改。
- `cloudflare`：在最新 `origin/main` 之上保留 Cloudflare 同源 API 代理等本地提交。
- 更新上游时使用 rebase，让本地提交重新应用到最新上游，避免产生合并提交。

Git 远端职责：

- `origin`：`CookSleep/gpt_image_playground` 上游，只用于拉取更新。
- `fork`：`wuzf/gpt_image_playground` 个人 fork，用于保存 `cloudflare` 分支。

当前 Cloudflare Worker 名为 `gpt-image-playground`，访问域名：

- `https://gptimage.guts.eu.org`
- `https://gpt-image-playground.wzf.workers.dev`

## 同步上游

开始前必须确认工作区干净：

```powershell
git switch cloudflare
git status --short
git fetch origin
git rebase origin/main
```

本仓库已启用 `pull.rebase=true` 和 `rerere.enabled=true`，因此也可以使用 `git pull`。显式执行 `fetch` + `rebase` 更容易确认同步过程和冲突位置。

发生冲突时：

```powershell
git status
# 编辑并解决冲突
git add <已解决的文件>
git rebase --continue
```

需要放弃本次同步时：

```powershell
git rebase --abort
```

不要把 `cloudflare` 合并回 `main`，也不要强制推送 `origin/main`。

## 推送 GitHub

rebase 会改写本地提交 ID，验证通过后使用 `--force-with-lease` 安全更新个人 fork：

```powershell
git push --force-with-lease fork cloudflare:cloudflare
```

不要给本地 `cloudflare` 设置 `fork/cloudflare` 为 upstream；它需要继续跟踪 `origin/main`，才能清楚显示相对上游领先的本地提交。

## 构建与测试

同步完成后执行：

```powershell
npm ci
npm run build:cf
npm test
npx wrangler deploy --dry-run
```

必须使用 `build:cf`。普通的 `npm run build` 不会读取 `.env.cf`，构建结果也不会启用并锁定同源 API 代理。

## 部署

确认构建、测试和 dry-run 全部通过后执行：

```powershell
npm run deploy:cf
```

部署完成后确认新版本已 100% 生效：

```powershell
npx wrangler deployments status --name gpt-image-playground
```

## 线上验证

代理预检应返回 `204`：

```powershell
curl.exe -i -X OPTIONS "https://gptimage.guts.eu.org/api-proxy/v1/responses"
```

使用无效测试 Key 验证请求已到达上游，预期返回 `401 INVALID_API_KEY`，不会产生图片生成费用：

```powershell
curl.exe -i -X POST "https://gptimage.guts.eu.org/api-proxy/v1/responses" `
  -H "Authorization: Bearer invalid-verification-key" `
  -H "Content-Type: application/json" `
  --data-raw "{}"
```

最后使用 Chrome DevTools 强制刷新 `https://gptimage.guts.eu.org` 并确认：

- 设置中的“API 代理”已开启且被部署端锁定。
- API 请求发往同源 `/api-proxy/...`，不再直接请求 `sub2api.guts.eu.org`。
- 控制台没有 CORS 错误。

## 配置说明

- `.env.cf`：仅包含会公开进入前端构建的 `VITE_*` 配置。
- `wrangler.jsonc`：配置 Worker 入口、静态资源和固定上游 `API_PROXY_URL`。
- `worker/index.ts`：只代理 `images/generations`、`images/edits` 和 `responses`，并原样透传 SSE。
- API Key 由使用者在页面中填写，经 `Authorization` 请求头转发；不要把 API Key 写入 `.env.cf`、`wrangler.jsonc` 或任何 `VITE_*` 变量。

该代理是公开的固定上游转发器。调用者仍需提供自己的上游 API Key，但可能消耗 Worker 请求配额，生产环境应在 Cloudflare 配置 WAF 或 Rate Limiting。
