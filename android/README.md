# Codex Bridge Android

这是 `codex-bridge` 的 Android 客户端项目，用来让手机通过预先配置的 Bridge 地址和 `appId` 访问当前电脑上的 Codex。

当前交付 APK：

```text
D:\Program Files\dev-project\github\codex-bridge\public\codex-bridge.apk
D:\Program Files\dev-project\github\codex-bridge\public\codex-bridge-test.apk
```

## 功能

- 保存 Bridge 地址 / 域名和 `appId`。
- 获取手机局域网 IPv4，并扫描同网段 `4555` 端口发现 Bridge。
- 检查 `/api/health`，确认 Bridge 与电脑端 Codex 状态。
- 查看当前 `appId` 可见的会话列表。
- 创建新对话、切换已有对话、读取会话消息。
- 在同一个 session 内连续对话。
- 中断当前会话里正在运行的回复或任务。
- 从手机选择图片，上传到电脑端 app 工作区，再以 `localImage` 输入交给 Codex。
- 渲染 assistant 回复里的公网图片 URL，以及当前 session 工作目录内的本机图片路径。

## 电脑端 Bridge 启动

手机不能访问电脑的 `127.0.0.1`。如果要让 APK 访问，需要让 `codex-bridge` 监听局域网地址：

```powershell
cd "D:\Program Files\dev-project\github\codex-bridge"
$env:CODEX_BRIDGE_HOST="0.0.0.0"
$env:CODEX_BRIDGE_PORT="4555"
$env:CODEX_BRIDGE_REQUIRE_AUTH="1"
npm start
```

建议在电脑端先打开 `http://127.0.0.1:4555` 创建 `appId`，再把这个 `appId` 填进手机 App。外部网络不在同一局域网时，仍然需要 VPN、端口映射、Tailscale/ZeroTier、Cloudflare Tunnel 或 frp 这类通道。

如果手机扫不到，优先检查 Windows 防火墙是否允许 `4555` 端口入站。

## 构建

```powershell
cd "D:\Program Files\dev-project\github\codex-bridge\android"
.\scripts\build-apk.ps1
```

APK 输出位置：

```text
codex-bridge.apk
codex-bridge-test.apk
app\build\outputs\apk\debug\app-debug.apk
```

构建脚本会同时同步 APK 到主仓 `public/` 目录，方便从 Bridge 控制台下载。

## 安装到手机

连接 Android 手机并打开 USB 调试后执行：

```powershell
cd "D:\Program Files\dev-project\github\codex-bridge\android"
.\scripts\install-apk.ps1
```

如果接了多台设备，先查看：

```powershell
adb devices -l
```

再指定设备：

```powershell
.\scripts\install-apk.ps1 -Serial <device-serial>
```

## 测试

```powershell
.\scripts\test.ps1
```

Bridge 侧手机合同 smoke：

```powershell
cd "D:\Program Files\dev-project\github\codex-bridge"
npm run smoke:android
```

## 边界

当前密钥是 `codex-bridge` 里的 `appId`。开启 `CODEX_BRIDGE_REQUIRE_AUTH=1` 后，Bridge 会把它作为外部应用访问白名单来校验；公网场景仍建议配合 HTTPS 或 VPN 使用。
