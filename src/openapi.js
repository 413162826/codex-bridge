export function createOpenApiSpec(config) {
  const serverUrl = `http://${config.server.host}:${config.server.port}`;

  return {
    openapi: '3.1.0',
    info: {
      title: 'Codex Bridge Local API',
      version: config.version,
      description: [
        '把本机 `codex app-server` 包装成一个更容易接入的本地 HTTP/SSE API。',
        '',
        '几个关键约定：',
        '- `cwd` 表示新 session 或 turn 默认在哪个项目目录下工作。',
        '- `appId` 表示调用方应用身份；如果传了 `appId`，session 默认会绑定到该 app 的 `workspaceRoot`。',
        '- `model / effort / sandbox / approvalPolicy / ephemeral` 是最核心的策略参数。',
        '- `speed` 目前主要是 bridge 侧的策略标签，方便 UI 和上层调用方表达偏好，当前不会直接映射到底层 app-server 官方参数。',
        '- `GET /api/events` 与 `GET /api/sessions/{sessionId}/events` 返回的是 SSE，不是普通 JSON。',
      ].join('\n'),
    },
    servers: [
      {
        url: serverUrl,
        description: 'Local Codex Bridge',
      },
    ],
    tags: [
      { name: 'Bridge', description: 'Bridge 自身状态、配置和健康检查' },
      { name: 'Codex Runtime', description: '控制本机 codex app-server 子进程' },
      { name: 'Apps', description: '管理 appId、默认配置和专属工作目录' },
      { name: 'Sessions', description: '创建、查看、恢复和归档 session' },
      { name: 'Turns', description: '发起对话、等待结果、打断和 steer' },
      { name: 'Streaming', description: 'SSE 事件流' },
      { name: 'High-level', description: '一次调用即流式输出的高级接口（/api/chat）' },
      { name: 'Account', description: '查看本机 Codex 账号状态和登录' },
      { name: 'Models', description: '读取本机 Codex 当前可用模型列表' },
      { name: 'Uploads', description: '手机或外部客户端上传图片到 app 工作区' },
      { name: 'Approvals', description: '处理 app-server 侧待响应的 server request' },
    ],
    paths: {
      '/api/health': {
        get: {
          tags: ['Bridge'],
          summary: '健康检查',
          description: '返回 bridge 当前配置和 codex 子进程状态，适合探活或启动后探针。',
          responses: okJsonResponse('#/components/schemas/HealthResponse'),
        },
      },
      '/api/status': {
        get: {
          tags: ['Bridge'],
          summary: '读取总状态',
          description: '返回 bridge 配置、codex 运行状态、session 摘要、最近事件和待处理 server request。',
          responses: okJsonResponse('#/components/schemas/StatusResponse'),
        },
      },
      '/api/config': {
        get: {
          tags: ['Bridge'],
          summary: '读取默认配置',
          description: '返回当前对外默认配置。新 session 会优先继承这些值。',
          responses: okJsonResponse('#/components/schemas/BridgeConfig'),
        },
        put: {
          tags: ['Bridge'],
          summary: '更新默认配置',
          description: '更新 bridge 默认配置。适合上层工作台、设置页或部署脚本调用。',
          requestBody: jsonRequestBody('#/components/schemas/BridgeConfigPatch', {
            codex: {
              cwd: 'D:\\Program Files\\dev-project\\github\\person-workbench',
              model: 'gpt-5.5',
              effort: 'high',
              speed: 'fast',
              sandbox: 'workspace-write',
              approvalPolicy: 'never',
              ephemeral: false,
            },
          }),
          responses: okJsonResponse('#/components/schemas/BridgeConfig'),
        },
      },
      '/api/codex/start': {
        post: {
          tags: ['Codex Runtime'],
          summary: '启动 codex app-server',
          description: '确保本机 `codex app-server` 子进程启动并完成初始化握手。',
          responses: okJsonResponse('#/components/schemas/CodexRuntimeResponse'),
        },
      },
      '/api/codex/restart': {
        post: {
          tags: ['Codex Runtime'],
          summary: '重启 codex app-server',
          description: '销毁旧子进程并重新拉起，适合修复卡死、刷新模型目录或登录态切换后的重连。',
          responses: okJsonResponse('#/components/schemas/CodexRuntimeResponse'),
        },
      },
      '/api/events': {
        get: {
          tags: ['Streaming'],
          summary: '订阅全局 SSE 事件流',
          description: '返回 `text/event-stream`。包含全局 session、turn、server request、stderr 和 bridge 自身事件。',
          responses: {
            '200': {
              description: 'SSE stream',
              content: {
                'text/event-stream': {
                  schema: {
                    type: 'string',
                    example: 'event: message\\ndata: {"type":"bridge.sse.connected"}\\n\\n',
                  },
                },
              },
            },
          },
        },
      },
      '/api/models': {
        get: {
          tags: ['Models'],
          summary: '读取模型列表',
          description: '读取本机 Codex 当前可见模型。默认不返回 hidden 模型；加 `includeHidden=1` 可包含内部模型。',
          parameters: [
            queryBool('includeHidden', '是否包含 hidden 模型，例如内部自动审查模型。', false),
          ],
          responses: okJsonResponse('#/components/schemas/ModelsResponse'),
        },
      },
      '/api/account': {
        get: {
          tags: ['Account'],
          summary: '读取账号状态',
          description: '读取本机 Codex 当前账号状态，例如 `chatgpt`、`apiKey`、计划类型等。',
          responses: okJsonResponse('#/components/schemas/AccountResponse'),
        },
      },
      '/api/account/login/start': {
        post: {
          tags: ['Account'],
          summary: '开始登录流程',
          description: '把登录请求透传给 app-server 的 `account/login/start`。支持 ChatGPT、API key 等官方模式。',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    { $ref: '#/components/schemas/ChatgptLoginRequest' },
                    { $ref: '#/components/schemas/ApiKeyLoginRequest' },
                  ],
                },
                examples: {
                  chatgpt: {
                    summary: 'ChatGPT 浏览器登录',
                    value: { type: 'chatgpt' },
                  },
                  apiKey: {
                    summary: 'API Key 登录',
                    value: { type: 'apiKey', apiKey: 'sk-***' },
                  },
                },
              },
            },
          },
          responses: okJsonResponse('#/components/schemas/GenericObjectResponse'),
        },
      },
      '/api/rate-limits': {
        get: {
          tags: ['Account'],
          summary: '读取限额状态',
          description: '读取当前账号在 Codex 侧的 rate limit / plan 信息。',
          responses: okJsonResponse('#/components/schemas/GenericObjectResponse'),
        },
      },
      '/api/apps': {
        get: {
          tags: ['Apps'],
          summary: '列出 APP',
          description: '返回当前已注册的 app 列表。每个 app 都有自己的 `appId`、`workspaceRoot` 和默认配置。',
          responses: okJsonResponse('#/components/schemas/AppsListResponse'),
        },
        post: {
          tags: ['Apps'],
          summary: '创建 APP',
          description: '自动生成一个 `appId(UUID)`，同时创建同名工作目录，并复制一份当前全局默认配置作为该 app 的初始配置。',
          requestBody: jsonRequestBody('#/components/schemas/CreateAppRequest', {
            name: 'release-console',
          }),
          responses: createdJsonResponse('#/components/schemas/AppResponse'),
        },
      },
      '/api/apps/{appId}': {
        get: {
          tags: ['Apps'],
          summary: '读取单个 APP',
          description: '返回这个 app 的完整配置，包括 `workspaceRoot` 和默认策略。',
          parameters: [appIdParam()],
          responses: okJsonResponse('#/components/schemas/AppResponse'),
        },
        put: {
          tags: ['Apps'],
          summary: '更新 APP',
          description: '更新 app 名称和默认配置。`workspaceRoot` 固定为该 app 的专属目录，不支持从外部修改。',
          parameters: [appIdParam()],
          requestBody: jsonRequestBody('#/components/schemas/UpdateAppRequest', {
            name: 'release-console-prod',
            defaults: {
              model: 'gpt-5.5',
              effort: 'high',
              speed: 'balanced',
              sandbox: 'workspace-write',
              approvalPolicy: 'never',
              ephemeral: false,
            },
          }),
          responses: okJsonResponse('#/components/schemas/AppResponse'),
        },
        delete: {
          tags: ['Apps'],
          summary: '删除 APP',
          description: '从注册表移除该 app，其 `appId` 立即失效（鉴权返回 401）。工作目录文件不会被删除。仅管理端（本机 / admin key）可调用，app scope 调用会 403。',
          parameters: [appIdParam()],
          responses: okJsonResponse('#/components/schemas/GenericObjectResponse'),
        },
      },
      '/api/uploads/images': {
        post: {
          tags: ['Uploads'],
          summary: '上传图片到 APP 工作区',
          description: [
            '把手机或外部客户端的 base64 图片保存到该 app 的 `workspaceRoot/uploads` 下。',
            '返回值里的 `upload.input` 可直接放进 `POST /api/sessions/{sessionId}/turns` 的 `input` 数组，让本机 Codex 按 `localImage` 读取图片。',
          ].join('\n'),
          requestBody: jsonRequestBody('#/components/schemas/ImageUploadRequest', {
            appId: '0322f41b-561e-43d0-b561-96ed72110918',
            fileName: 'phone-photo.png',
            mimeType: 'image/png',
            base64: 'iVBORw0KGgo=',
          }),
          responses: createdJsonResponse('#/components/schemas/ImageUploadResponse'),
        },
      },
      '/api/chat': {
        post: {
          tags: ['High-level'],
          summary: '建会话 + 流式对话（一次调用）',
          description: [
            '一个请求完成：创建 session（`thread/start`）+ 发起第一轮（`turn/start`）+ 以 `text/event-stream` 流式返回这一轮输出。**无需先建 session、无需轮询。**',
            '',
            '外部接入走域名时带 `Authorization: Bearer <appId>`；本机调用免鉴权。',
            '',
            'SSE 事件按 `event:` 名区分：',
            '- `session`：首帧，含 `sessionId`，用于后续 `POST /api/sessions/{id}/turns?stream=1` 续轮。',
            '- `delta`：逐字增量文本。',
            '- `image`：生成图片（`url` 始终有；≤256KB 时附 `dataUrl` 内联 base64）。',
            '- `usage`：token 用量。`done`：终止帧（含 `status`、`finalText`）。`error`：流中途错误。`ping`：15s 心跳。',
          ].join('\n'),
          requestBody: jsonRequestBody('#/components/schemas/ChatRequest', {
            text: '用一句话解释快速排序',
            appId: '0322f41b-561e-43d0-b561-96ed72110918',
            effort: 'low',
          }),
          responses: {
            '200': {
              description: 'SSE 流（text/event-stream）',
              content: {
                'text/event-stream': {
                  schema: {
                    type: 'string',
                    example:
                      'event: session\\ndata: {"sessionId":"019e..."}\\n\\nevent: delta\\ndata: {"delta":"你好","seq":0}\\n\\nevent: done\\ndata: {"status":"completed","finalText":"你好"}\\n\\n',
                  },
                },
              },
            },
            ...errorResponse(),
          },
        },
      },
      '/api/sessions': {
        get: {
          tags: ['Sessions'],
          summary: '列出 session',
          description: '返回当前 bridge 已知的 session 摘要列表。',
          responses: okJsonResponse('#/components/schemas/SessionsListResponse'),
        },
        post: {
          tags: ['Sessions'],
          summary: '创建新 session',
          description: [
            '创建一个新 session，本质上会调用 app-server 的 `thread/start`。',
            '',
            '注意：',
            '- 如果传了 `appId`，`cwd` 固定使用该 app 的 `workspaceRoot`，不会接受外部覆盖。',
            '- `effort` 会存为该 session 的默认 turn 策略，但不会在 `thread/start` 时直接下发。',
            '- `speed` 目前只是 bridge 侧标签，不直接约束底层 app-server。',
          ].join('\n'),
          requestBody: jsonRequestBody('#/components/schemas/CreateSessionRequest', {
            appId: '0322f41b-561e-43d0-b561-96ed72110918',
            name: 'release-console',
            model: 'gpt-5.5',
            effort: 'high',
            speed: 'fast',
            sandbox: 'workspace-write',
            approvalPolicy: 'never',
            ephemeral: false,
            persistExtendedHistory: true,
          }),
          responses: createdJsonResponse('#/components/schemas/SessionResponse'),
        },
      },
      '/api/sessions/{sessionId}': {
        get: {
          tags: ['Sessions'],
          summary: '读取单个 session',
          description: '返回单个 session 的完整内容，包括消息、turn、事件和策略字段。',
          parameters: [sessionIdParam()],
          responses: okJsonResponse('#/components/schemas/SessionResponse'),
        },
      },
      '/api/sessions/{sessionId}/resume': {
        post: {
          tags: ['Sessions'],
          summary: '恢复 session',
          description: '基于已有 `threadId` 恢复 session，本质上调用 app-server 的 `thread/resume`。',
          parameters: [sessionIdParam()],
          requestBody: jsonRequestBody('#/components/schemas/ResumeSessionRequest', {
            model: 'gpt-5.4',
            sandbox: 'workspace-write',
            approvalPolicy: 'never',
          }),
          responses: okJsonResponse('#/components/schemas/SessionResponse'),
        },
      },
      '/api/sessions/{sessionId}/events': {
        get: {
          tags: ['Streaming'],
          summary: '订阅某个 session 的 SSE 事件流',
          description: '返回这个 session 相关的流式事件，适合聊天窗口或任务详情页。',
          parameters: [sessionIdParam()],
          responses: {
            '200': {
              description: 'SSE stream',
              content: {
                'text/event-stream': {
                  schema: {
                    type: 'string',
                    example: 'event: message\\ndata: {"method":"item/agentMessage/delta"}\\n\\n',
                  },
                },
              },
            },
          },
        },
      },
      '/api/sessions/{sessionId}/files': {
        get: {
          tags: ['Sessions'],
          summary: '读取 session 工作目录内的图片文件',
          description: '用于手机端查看 Codex 生成在当前 session 工作目录内的图片。`path` 必须位于该 session 的 `cwd` 内。',
          parameters: [
            sessionIdParam(),
            {
              name: 'path',
              in: 'query',
              required: true,
              schema: { type: 'string' },
              description: '电脑本地图片绝对路径，必须位于当前 session 工作目录内。',
            },
          ],
          responses: {
            '200': {
              description: 'Image file',
              content: {
                'image/png': { schema: { type: 'string', format: 'binary' } },
                'image/jpeg': { schema: { type: 'string', format: 'binary' } },
                'image/webp': { schema: { type: 'string', format: 'binary' } },
                'image/gif': { schema: { type: 'string', format: 'binary' } },
              },
            },
            ...errorResponse(),
          },
        },
      },
      '/api/sessions/{sessionId}/turns': {
        post: {
          tags: ['Turns'],
          summary: '发起一轮 turn',
          description: [
            '发起一轮新对话，本质上调用 app-server 的 `turn/start`。',
            '',
            '支持两种输入方式：',
            '- 传 `text` / `prompt`：最简单文本输入',
            '- 传 `input` 数组：高级模式，支持 `text`、`image`、`localImage`、`skill`、`mention`',
            '- 这版 bridge 不允许外部为 turn 单独传 `cwd`；工作目录来自该 session。',
          ].join('\n'),
          parameters: [
            sessionIdParam(),
            queryBool('wait', '是否等待本轮完成后再返回完整 session。', false),
            queryBool('stream', '是否以 text/event-stream 流式返回这一轮（类型化事件同 /api/chat；与 wait 互斥）。', false),
          ],
          requestBody: jsonRequestBody('#/components/schemas/StartTurnRequest', {
            text: '总结当前项目结构',
            model: 'gpt-5.5',
            effort: 'high',
          }),
          responses: {
            '200': {
              description: '`wait=1` 返回完整 session（JSON）；`stream=1` 返回 text/event-stream（类型化事件同 /api/chat）。',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/TurnResponse' },
                },
                'text/event-stream': {
                  schema: {
                    type: 'string',
                    example: 'event: delta\\ndata: {"turnId":"...","delta":"你好","seq":0}\\n\\n',
                  },
                },
              },
            },
            '202': {
              description: '已接受 turn，请改用 SSE 继续追踪',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/TurnAcceptedResponse' },
                },
              },
            },
          },
        },
      },
      '/api/sessions/{sessionId}/interrupt': {
        post: {
          tags: ['Turns'],
          summary: '打断当前 turn',
          description: '如果这个 session 还有 active turn，就向 app-server 发送 `turn/interrupt`。',
          parameters: [sessionIdParam()],
          responses: okJsonResponse('#/components/schemas/GenericObjectResponse'),
        },
      },
      '/api/sessions/{sessionId}/steer': {
        post: {
          tags: ['Turns'],
          summary: '给当前 turn 追加指令',
          description: '向仍在运行的 turn 追加输入，本质上调用 app-server 的 `turn/steer`。',
          parameters: [sessionIdParam()],
          requestBody: jsonRequestBody('#/components/schemas/SteerTurnRequest', {
            text: '补充要求：只改最小范围',
          }),
          responses: okJsonResponse('#/components/schemas/GenericObjectResponse'),
        },
      },
      '/api/sessions/{sessionId}/archive': {
        post: {
          tags: ['Sessions'],
          summary: '归档 session',
          description: '把这个 session 标记为 archived，并调用 app-server 的 `thread/archive`。',
          parameters: [sessionIdParam()],
          responses: okJsonResponse('#/components/schemas/GenericObjectResponse'),
        },
      },
      '/api/server-requests': {
        get: {
          tags: ['Approvals'],
          summary: '列出待响应 server request',
          description: '查看 app-server 当前挂起的 server request，例如审批或动态工具请求。',
          responses: okJsonResponse('#/components/schemas/ServerRequestsResponse'),
        },
      },
      '/api/server-requests/{requestId}/respond': {
        post: {
          tags: ['Approvals'],
          summary: '响应待处理 server request',
          description: '向 app-server 回应某个待处理 server request。适合审批 UI 或 host app 回调。',
          parameters: [
            {
              name: 'requestId',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: '待响应的 server request id',
            },
          ],
          requestBody: jsonRequestBody('#/components/schemas/RespondServerRequestBody', {
            result: { decision: 'accept' },
          }),
          responses: okJsonResponse('#/components/schemas/GenericObjectResponse'),
        },
      },
      '/api': {
        get: {
          tags: ['Bridge'],
          summary: '读取简版 API 列表',
          description: '返回 bridge 当前暴露的接口清单。适合轻量发现，不如 Swagger 详细。',
          responses: okJsonResponse('#/components/schemas/ApiDocResponse'),
        },
      },
      '/api/openapi.json': {
        get: {
          tags: ['Bridge'],
          summary: '读取 OpenAPI 文档',
          description: '返回 Swagger / OpenAPI 3.1 JSON，可直接给 Swagger UI、Postman 或别的 agent 使用。',
          responses: {
            '200': {
              description: 'OpenAPI 3.1 document',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    additionalProperties: true,
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        GenericObjectResponse: {
          type: 'object',
          additionalProperties: true,
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', example: '未知 session：123' },
                statusCode: { type: 'integer', example: 404 },
              },
              required: ['message', 'statusCode'],
            },
          },
          required: ['error'],
        },
        BridgeConfig: {
          type: 'object',
          properties: {
            bridgeId: { type: 'string' },
            version: { type: 'string' },
            startedAt: { type: 'string', format: 'date-time' },
            server: {
              type: 'object',
              properties: {
                host: { type: 'string', example: '127.0.0.1' },
                port: { type: 'integer', example: 4555 },
                cors: { type: 'boolean', example: true },
              },
            },
            codex: { $ref: '#/components/schemas/CodexConfig' },
            apps: {
              type: 'object',
              properties: {
                count: { type: 'integer', example: 2 },
              },
            },
            ui: {
              type: 'object',
              properties: {
                refreshMs: { type: 'integer', example: 1500 },
                maxEventRows: { type: 'integer', example: 300 },
                defaultSessionName: { type: 'string', example: 'New Codex Session' },
              },
            },
            api: { $ref: '#/components/schemas/ApiDocResponse' },
          },
        },
        CodexConfig: {
          type: 'object',
          properties: {
            cwd: {
              type: 'string',
              description: '默认项目目录。决定 session/turn 默认在哪个项目下工作。',
              example: 'D:\\Program Files\\dev-project\\github\\person-workbench',
            },
            serviceName: { type: 'string', example: 'codex_bridge' },
            model: {
              type: ['string', 'null'],
              description: '`null` 表示 Auto / Codex default。',
              example: 'gpt-5.5',
            },
            effort: {
              type: 'string',
              enum: ['minimal', 'low', 'medium', 'high', 'xhigh'],
              example: 'low',
            },
            speed: {
              type: 'string',
              description: 'Bridge 侧速度偏好标签，当前不直接映射到底层 app-server 官方参数。',
              example: 'balanced',
            },
            approvalPolicy: {
              type: 'string',
              enum: ['never', 'on-request', 'untrusted'],
              example: 'never',
            },
            sandbox: {
              type: 'string',
              enum: ['read-only', 'workspace-write', 'danger-full-access'],
              example: 'workspace-write',
            },
            ephemeral: {
              type: 'boolean',
              description: '是否默认创建临时 session。',
              example: false,
            },
            experimentalRawEvents: { type: 'boolean', example: false },
            persistExtendedHistory: { type: 'boolean', example: true },
          },
        },
        BridgeConfigPatch: {
          type: 'object',
          properties: {
            codex: { $ref: '#/components/schemas/CodexConfig' },
          },
        },
        HealthResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', example: true },
            bridge: { $ref: '#/components/schemas/BridgeConfig' },
            codex: { $ref: '#/components/schemas/CodexRuntimeStatus' },
          },
        },
        CodexRuntimeResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', example: true },
            codex: { $ref: '#/components/schemas/CodexRuntimeStatus' },
          },
        },
        StatusResponse: {
          type: 'object',
          properties: {
            bridge: { $ref: '#/components/schemas/BridgeConfig' },
            codex: { $ref: '#/components/schemas/CodexRuntimeStatus' },
            sessions: {
              type: 'array',
              items: { $ref: '#/components/schemas/SessionSummary' },
            },
            serverRequests: {
              type: 'array',
              items: { $ref: '#/components/schemas/ServerRequest' },
            },
            events: {
              type: 'array',
              items: { $ref: '#/components/schemas/EventRecord' },
            },
          },
        },
        CodexRuntimeStatus: {
          type: 'object',
          properties: {
            started: { type: 'boolean', example: true },
            pid: { type: ['integer', 'null'], example: 23336 },
            cwd: { type: 'string' },
            pendingResponses: { type: 'integer', example: 0 },
            pendingServerRequests: { type: 'integer', example: 0 },
            stderrTail: { type: 'string', example: '' },
          },
        },
        SessionSummary: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            threadId: { type: 'string' },
            appId: { type: ['string', 'null'] },
            codexSessionId: { type: 'string' },
            name: { type: 'string' },
            status: { type: 'string', example: 'ready' },
            runtimeStatus: {
              type: 'object',
              additionalProperties: true,
            },
            cwd: { type: 'string' },
            model: { type: ['string', 'null'] },
            effort: { type: 'string' },
            speed: { type: 'string' },
            sandbox: { type: 'string' },
            approvalPolicy: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
            activeTurnId: { type: ['string', 'null'] },
            messageCount: { type: 'integer' },
            turnCount: { type: 'integer' },
            eventCount: { type: 'integer' },
            tokenUsage: {
              type: 'object',
              additionalProperties: true,
            },
            lastMessage: {
              type: ['object', 'null'],
              additionalProperties: true,
            },
          },
        },
        SessionResponse: {
          type: 'object',
          properties: {
            session: {
              type: 'object',
              additionalProperties: true,
            },
          },
        },
        SessionsListResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: { $ref: '#/components/schemas/SessionSummary' },
            },
          },
        },
        CreateSessionRequest: {
          type: 'object',
          properties: {
            appId: { type: 'string', description: '应用身份。传了以后，默认 `cwd` 从该 app 的 `workspaceRoot` 取值。' },
            name: { type: 'string' },
            initialPrompt: { type: 'string' },
            model: { type: ['string', 'null'] },
            effort: { type: 'string' },
            speed: { type: 'string' },
            approvalPolicy: { type: 'string' },
            sandbox: { type: 'string' },
            serviceName: { type: 'string' },
            ephemeral: { type: 'boolean' },
            experimentalRawEvents: { type: 'boolean' },
            persistExtendedHistory: { type: 'boolean' },
          },
        },
        ResumeSessionRequest: {
          type: 'object',
          properties: {
            model: { type: ['string', 'null'] },
            approvalPolicy: { type: 'string' },
            sandbox: { type: 'string' },
          },
        },
        StartTurnRequest: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '最简单的文本输入。' },
            prompt: { type: 'string', description: 'text 的别名。' },
            input: {
              type: 'array',
              description: '高级输入模式，可直接传 app-server input 数组。',
              items: { $ref: '#/components/schemas/UserInput' },
            },
            approvalPolicy: { type: 'string' },
            sandboxPolicy: {
              type: 'object',
              additionalProperties: true,
            },
            model: { type: ['string', 'null'] },
            effort: { type: 'string' },
            personality: { type: ['string', 'null'] },
            serviceTier: {
              type: ['string', 'null'],
            },
            outputSchema: {
              type: ['object', 'null'],
              additionalProperties: true,
            },
            collaborationMode: {
              type: ['object', 'null'],
              additionalProperties: true,
            },
          },
        },
        ChatRequest: {
          type: 'object',
          description: '建会话 + 第一轮的合并入参：session 策略字段（appId/model/sandbox 等）+ 这一轮的输入（text 或 input）。',
          properties: {
            text: { type: 'string', description: '最简单的文本输入。' },
            prompt: { type: 'string', description: 'text 的别名。' },
            input: {
              type: 'array',
              description: '高级输入数组（text/image/localImage）。',
              items: { $ref: '#/components/schemas/UserInput' },
            },
            appId: { type: 'string', description: '应用身份；app scope 调用会强制为当前 appId。' },
            name: { type: 'string', description: '新 session 名称。' },
            model: { type: ['string', 'null'] },
            effort: { type: 'string' },
            sandbox: { type: 'string' },
            approvalPolicy: { type: 'string' },
            ephemeral: { type: 'boolean' },
          },
        },
        UserInput: {
          oneOf: [
            {
              type: 'object',
              properties: {
                type: { type: 'string', const: 'text' },
                text: { type: 'string' },
                text_elements: {
                  type: 'array',
                  items: { type: 'object', additionalProperties: true },
                },
              },
              required: ['type', 'text', 'text_elements'],
            },
            {
              type: 'object',
              properties: {
                type: { type: 'string', const: 'image' },
                url: { type: 'string' },
              },
              required: ['type', 'url'],
            },
            {
              type: 'object',
              properties: {
                type: { type: 'string', const: 'localImage' },
                path: { type: 'string' },
              },
              required: ['type', 'path'],
            },
          ],
        },
        TurnAcceptedResponse: {
          type: 'object',
          properties: {
            session: { $ref: '#/components/schemas/SessionSummary' },
            turn: {
              type: 'object',
              additionalProperties: true,
            },
          },
        },
        TurnResponse: {
          type: 'object',
          properties: {
            session: {
              type: 'object',
              additionalProperties: true,
            },
            turn: {
              type: 'object',
              additionalProperties: true,
            },
          },
        },
        SteerTurnRequest: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            input: {
              type: 'array',
              items: { $ref: '#/components/schemas/UserInput' },
            },
          },
        },
        ModelsResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  displayName: { type: 'string' },
                  description: { type: 'string' },
                  hidden: { type: 'boolean' },
                  inputModalities: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                  defaultReasoningEffort: { type: 'string' },
                  supportedReasoningEfforts: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: true,
                    },
                  },
                  supportsPersonality: { type: 'boolean' },
                  isDefault: { type: 'boolean' },
                },
              },
            },
            nextCursor: { type: ['string', 'null'] },
          },
        },
        AccountResponse: {
          type: 'object',
          properties: {
            account: {
              type: ['object', 'null'],
              additionalProperties: true,
            },
            requiresOpenaiAuth: { type: 'boolean' },
          },
        },
        ChatgptLoginRequest: {
          type: 'object',
          properties: {
            type: { type: 'string', const: 'chatgpt' },
          },
          required: ['type'],
        },
        ApiKeyLoginRequest: {
          type: 'object',
          properties: {
            type: { type: 'string', const: 'apiKey' },
            apiKey: { type: 'string' },
          },
          required: ['type', 'apiKey'],
        },
        ServerRequest: {
          type: 'object',
          properties: {
            id: { type: ['string', 'integer'] },
            method: { type: 'string' },
            params: {
              type: 'object',
              additionalProperties: true,
            },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        ServerRequestsResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: { $ref: '#/components/schemas/ServerRequest' },
            },
          },
        },
        RespondServerRequestBody: {
          type: 'object',
          properties: {
            result: {
              type: 'object',
              additionalProperties: true,
            },
            error: {
              type: 'object',
              additionalProperties: true,
            },
          },
        },
        EventRecord: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            type: { type: 'string' },
            method: { type: 'string' },
            sessionId: { type: 'string' },
            params: {
              type: 'object',
              additionalProperties: true,
            },
            request: {
              type: 'object',
              additionalProperties: true,
            },
            receivedAt: { type: 'string', format: 'date-time' },
          },
          additionalProperties: true,
        },
        ApiDocResponse: {
          type: 'object',
          properties: {
            endpoints: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        },
        AppDefaults: {
          type: 'object',
          properties: {
            model: { type: ['string', 'null'] },
            effort: { type: 'string' },
            speed: { type: 'string' },
            approvalPolicy: { type: 'string' },
            sandbox: { type: 'string' },
            ephemeral: { type: 'boolean' },
            experimentalRawEvents: { type: 'boolean' },
            persistExtendedHistory: { type: 'boolean' },
            serviceName: { type: ['string', 'null'] },
          },
        },
        AppRecord: {
          type: 'object',
          properties: {
            appId: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            workspaceRoot: { type: 'string' },
            enabled: { type: 'boolean', description: '是否启用；停用后该 appId 无法再鉴权访问。', example: true },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
            defaults: { $ref: '#/components/schemas/AppDefaults' },
          },
        },
        AppResponse: {
          type: 'object',
          properties: {
            app: { $ref: '#/components/schemas/AppRecord' },
          },
        },
        AppsListResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: { $ref: '#/components/schemas/AppRecord' },
            },
          },
        },
        CreateAppRequest: {
          type: 'object',
          properties: {
            name: { type: 'string' },
          },
        },
        UpdateAppRequest: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            enabled: { type: 'boolean', description: '启用/停用该 app；停用后其 appId 无法鉴权。' },
            defaults: { $ref: '#/components/schemas/AppDefaults' },
          },
        },
        ImageUploadRequest: {
          type: 'object',
          properties: {
            appId: { type: 'string', description: '管理端调用时指定 app；app scope 调用会强制使用当前 access key 对应 app。' },
            fileName: { type: 'string', example: 'phone-photo.png' },
            mimeType: { type: 'string', example: 'image/png' },
            base64: { type: 'string', description: '图片 base64，可带 data:image/...;base64, 前缀。' },
          },
          required: ['base64'],
        },
        ImageUploadResponse: {
          type: 'object',
          properties: {
            upload: {
              type: 'object',
              properties: {
                fileName: { type: 'string' },
                originalName: { type: 'string' },
                mimeType: { type: 'string' },
                size: { type: 'integer' },
                path: { type: 'string' },
                input: {
                  type: 'object',
                  properties: {
                    type: { type: 'string', const: 'localImage' },
                    path: { type: 'string' },
                  },
                  required: ['type', 'path'],
                },
              },
              required: ['fileName', 'mimeType', 'size', 'path', 'input'],
            },
          },
        },
      },
    },
  };
}

function okJsonResponse(schemaRef) {
  return {
    '200': {
      description: 'OK',
      content: {
        'application/json': {
          schema: { $ref: schemaRef },
        },
      },
    },
    ...errorResponse(),
  };
}

function createdJsonResponse(schemaRef) {
  return {
    '201': {
      description: 'Created',
      content: {
        'application/json': {
          schema: { $ref: schemaRef },
        },
      },
    },
    ...errorResponse(),
  };
}

function jsonRequestBody(schemaRef, example) {
  return {
    required: true,
    content: {
      'application/json': {
        schema: { $ref: schemaRef },
        example,
      },
    },
  };
}

function errorResponse() {
  return {
    '400': {
      description: 'Bad Request',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ErrorResponse' },
        },
      },
    },
    '404': {
      description: 'Not Found',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ErrorResponse' },
        },
      },
    },
    '409': {
      description: 'Conflict',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ErrorResponse' },
        },
      },
    },
    '500': {
      description: 'Internal Server Error',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ErrorResponse' },
        },
      },
    },
  };
}

function queryBool(name, description, defaultValue) {
  return {
    name,
    in: 'query',
    required: false,
    description,
    schema: {
      type: 'boolean',
      default: defaultValue,
    },
  };
}

function sessionIdParam() {
  return {
    name: 'sessionId',
    in: 'path',
    required: true,
    description: 'bridge 侧 session id，当前与 threadId 相同。',
    schema: {
      type: 'string',
      example: '019e9bd4-a9ae-7680-96f1-02535ffc800a',
    },
  };
}

function appIdParam() {
  return {
    name: 'appId',
    in: 'path',
    required: true,
    description: 'APP 身份标识，也是专属工作目录名。',
    schema: {
      type: 'string',
      format: 'uuid',
      example: '0322f41b-561e-43d0-b561-96ed72110918',
    },
  };
}
