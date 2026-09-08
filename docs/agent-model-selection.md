# 新建分析的外部 Agent 模型选择

本轮基于 `feat/module-analysis-five-stages`，包含此前已合入的资产工作区改动。Agent 分析 Skill 不变。

## 使用行为

- 新建分析选择 NGA、CodeAgent、OpenCode 或 Claude Code 后自动读取可用模型，支持刷新。默认选项是“使用 Agent 默认”；只有主动指定的模型写入任务的 `agent_model`。
- 指定模型会在真正的分析会话中、发送 Prompt 之前应用。模型失效、Agent 拒绝切换或返回的配置未应用选择时，启动失败，不改用默认模型继续。Agent 自身后续的动态模型调整仍以其上报为准。
- 任务重启读取、停止后续跑保留 `agent_model`；切换执行 Agent 时清空旧 Agent 的选择。旧任务缺少此字段继续按默认模型启动，无需迁移。
- 模型列表读取不创建 PANGEA Task、Run 或 DSH 所属会话，不发送 Prompt。ACP 为读取会话配置需要新建一个临时远端会话，远端是否留下空会话由 Agent 决定。探测结束通过既有 subprocess 生命周期回收子进程。
- 读取在 20 秒后发出取消，随后等待已有进程回收；时间上限不包含进程回收耗时。切换 Agent、离开页面或取消 HTTP 请求也会取消探测。不会在工作台轮询中反复探测。
- 列表读取失败会显示原因并允许重试；Agent 未提供模型时显示“使用默认”，不编造可选模型或要求手动维护目录。
- Agent Runtime 默认显示已加载状态和版本。路径、登录状态、启动命令及检查按钮收在关闭的“高级启动设置与诊断”。日常选择 Agent 和模型无需访问这里。

## 实现对应

| Agent | 模型来源 | 启动时应用 |
|---|---|---|
| NGA / CodeAgent / OpenCode | `session/new` 的 `configOptions`（model 类别，支持分组）；兼容 `models.availableModels` | `session/set_config_option`；旧接口使用 `session/set_model` |
| Claude Code | 官方 Agent SDK `supportedModels()` | SDK `model` 参数；当前会话公布列表确认后才释放用户 Prompt |

ACP 的配置选择与返回当前值遵循 [Session Config Options](https://agentclientprotocol.com/protocol/v1/session-config-options)。Claude 使用锁定依赖 `@anthropic-ai/claude-agent-sdk@0.3.220` 的 `Query.supportedModels()`；未新增依赖。请求字段只在宿主使用，不混入 Python Skill 的严格输入。

## 自动验收

- 本轮结果：Companion 150/150，产品前端相关 23/23；Desktop ACP/Claude/运行时相关 34 通过、1 跳过；Desktop typecheck、Electron Vite build 通过；两份运行时补丁在原始依赖上由 patch-package 应用通过。
- 使用真实 ACP SDK 和 subprocess、模拟 Agent JSON-RPC 进程验证现代/旧式/空模型目录、切换在 Prompt 前完成、同一会话继续 Prompt 保留模型、拒绝/未应用选择不发送 Prompt、握手停滞时取消并回收进程。
- 使用真实 Claude SDK 和 subprocess、模拟 CLI 控制协议验证读取模型不提交用户消息、SDK 收到模型参数、失效模型不发送 Prompt、初始化停滞可取消。
- Companion 回归覆盖四种 Agent 的模型选择、任务持久化/重启/续跑、执行方式切换、宿主路由传参，以及高级设置默认折叠。
- 本环境未安装用户的 NGA、CodeAgent、OpenCode、Claude Code 命令，也未访问其登录账户。协议模拟测试与 Linux 构建不代替真实 Windows Agent 的模型列表及模型请求验收。

## Windows 验收入口

直接进入“新建分析”，逐个选择已安装的 Agent，确认列表与 Agent 自己提供的模型一致；选择一个不同于默认的模型启动，在启动诊断中比较“指定”与 Agent 实际上报模型。停止后续跑应保留指定值。Agent Runtime 无需打开；仅命令找不到时查看高级诊断。旧任务打开和续跑仍沿用默认行为。
