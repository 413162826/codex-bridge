# Codex Bridge

本项目把本机 `codex app-server` 包成一个本地 HTTP/SSE API，并提供一个可观测的 `index.html` 控制台。

默认监听：

```text
http://127.0.0.1:4555
```

## 启动

```powershell
npm start
```

打开：

```text
http://127.0.0.1:4555
```

Swagger：

```text
http://127.0.0.1:4555/docs
http://127.0.0.1:4555/api/openapi.json
```

## 前置条件

先确认本机 Codex 已安装并登录：

```powershell
codex --version
codex
```

## 常用环境变量

```powershell
$env:CODEX_BRIDGE_PORT=4555
$env:CODEX_BRIDGE_HOST="127.0.0.1"
$env:CODEX_BRIDGE_CWD="D:\Program Files\dev-project\github\person-workbench"
$env:CODEX_BRIDGE_MODEL=""
$env:CODEX_BRIDGE_EFFORT="low"
$env:CODEX_BRIDGE_SANDBOX="workspace-write"
$env:CODEX_BRIDGE_APPROVAL_POLICY="never"
npm start
```

## API 小抄

```text
GET  /api/health
GET  /api/status
GET  /api/config
GET  /api/openapi.json
PUT  /api/config
POST /api/codex/start
POST /api/codex/restart
GET  /api/events
GET  /api/models
GET  /api/account
GET  /api/rate-limits
GET  /api/apps
POST /api/apps
GET  /api/apps/:id
PUT  /api/apps/:id
GET  /api/sessions
POST /api/sessions
GET  /api/sessions/:id
POST /api/sessions/:id/resume
GET  /api/sessions/:id/events
POST /api/sessions/:id/turns
POST /api/sessions/:id/turns?wait=1
POST /api/sessions/:id/interrupt
POST /api/sessions/:id/steer
POST /api/sessions/:id/archive
```

## 创建 session

```powershell
Invoke-RestMethod http://127.0.0.1:4555/api/sessions `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"name":"demo","ephemeral":true}'
```

## 创建 appId

```powershell
Invoke-RestMethod http://127.0.0.1:4555/api/apps `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"name":"release-console"}'
```

它会：

- 自动生成一个 `appId(UUID)`
- 自动创建 `workspaces/<appId>` 目录
- 自动复制当前全局默认配置作为这个 app 的初始配置

## 发送一轮对话

```powershell
$sid = "<session id>"
Invoke-RestMethod "http://127.0.0.1:4555/api/sessions/$sid/turns?wait=1" `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"text":"只回复 OK"}'
```

## 事件流

```text
GET /api/events
GET /api/sessions/:id/events
```

它们是 SSE，前端可以直接：

```js
const es = new EventSource("/api/events");
es.onmessage = (event) => console.log(JSON.parse(event.data));
```

## 设计边界

这一版是本机开发版：

- 默认无登录鉴权。
- 默认只监听 `127.0.0.1`。
- CORS 默认打开，方便本机调试。
- 不建议直接暴露公网。

真正给其他项目使用时，建议让外部应用调用本 Bridge 的 HTTP/SSE API，而不是直接连接 `codex app-server`。
