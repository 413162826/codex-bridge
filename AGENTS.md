# 项目约定

- `codex-bridge` 只维护 Bridge 后端、Web/PWA 手机端、API 文档与 smoke 脚本。
- 不要在本仓新增或恢复 Android 原生 quick test App；旧 `android/` 目录和根目录 APK 下载入口已废弃。
- 正式 Android 客户端只在兄弟项目 `codex-bridge-android` 中修改、构建和安装。
- Android 多轮对话统一走 `/api/mobile/chat`，新对话必须带 `projectId`；不要由 Android 端传 `cwd`、`sandbox`、`approvalPolicy` 这类执行策略。
- 任何 app-server 相关操作（方法名、参数、事件、权限字段）必须先查 Codex 官方文档或用 `codex app-server generate-ts/generate-json-schema` 生成官方协议定义；Bridge 服务端恢复桌面执行画像时，必须区分 rollout 历史、`@openai/codex-sdk` 与 app-server wire 协议，不要把 SDK/历史里的 `sandboxPolicy` 对象直接传给 app-server 的 `thread/start` 或 `thread/resume`。
