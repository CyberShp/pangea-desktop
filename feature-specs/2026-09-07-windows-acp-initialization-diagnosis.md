# Windows ACP 初始化排查 Implementation Plan

**Feature:** codetalks-skill 内网 Windows ACP 执行排查；未分配 Feature 编号。
**Goal:** 定位 NGA/OpenCode 未在当前 Run 写出初始化状态的实际原因，验证 CodeAgent 内部 PowerShell，并交付可在内网验收的独立 Windows 测试实例。
**Acceptance Criteria:** 见下方最终验收标准。
**Architecture cell:** Desktop ACP Provider / Companion 执行编排 / Agent Skill Run；沿用现有仓库边界。
**Map delta:** none。
**Map delta why:** 使用现有 ACP、Job、启动日志和 run_guard，不新增执行架构。
**Architecture:** 先修正已证明的诊断与字段契约缺口，再通过与 Desktop 相同的 Provider 启动链逐段验证初始化。只有证据指向具体原因后才实施对应修复。
**Tech Stack:** Electron、Node.js、ACP SDK、Cordis/DSH、PowerShell、Python。
**前端验证:** 仅在修改诊断展示或默认模型文案时涉及；自动化检查后在独立实例检查展示，真实内网交互由用户最终验收。

## 已核实基线

| 仓库 | codetalks-skill HEAD |
| --- | --- |
| Desktop | 8a1e3bcd41aebbb2f1861b437043d5b3fe23a807 |
| DSH 插件 | a2164c14471f53f5fe5a6641886595514006e700 |
| Agent | 1651113790a1d42e4776a40a18c9ef1a5c4cea13 |

- 家里与内网均通过 Desktop 启动；启动入口差异不是已证实原因。
- Python `runs get` 在当前 Run 状态文件缺失时返回 PREPARING；写入初始化状态后返回 STEP_BOOTSTRAP。
- Companion 续接读取 `analysis.completed`，Python 实际返回 `completed_steps`。隔离数据调用真实 public_api 已验证该差异。
- 日志 `agent_session_id` 取本地 `run.id`。远端 sessionId 存在于 adapter 内部，尚未暴露；批处理模式下 processId 为被启动的 cmd 进程 PID。
- 当前远端未包含交接所述 PowerShell 默认值、新增 ACP 诊断和 OOM 对比脚本修正；此前 23/23 是交接记录，不能算作本工作区的验证。
- 本轮 Windows 验证：插件相关 123/123；Agent 阶段发布 6/6；快照 7/7，包含真实目录句柄占用。以上不是内网真实 Provider 验收。

## 实施范围

保留现有 Skill 九步流程、用户配置和模型默认选择。保持 Windows 批处理启动、快照重试、Run/attempt/session 隔离回归。模型选择只做观测；凭据继承继续遵守现有过滤边界。

本轮不恢复旧 Graph、不新增模型配置系统、不放开全部凭据、不修改用户历史 Run、不增加生产 adapter 的全局延迟，也不通过扩大自动续接次数掩盖初始化失败。

## 最终诊断字段

扩展现有启动日志白名单；未知值明确缺失，禁止用本地值伪装远端值：

- Provider 与 CLI 版本；工作目录；启动方式；启动器 PID。
- 本地 run.id 与远端 ACP sessionId 分别记录。
- Agent 在 session/new 或配置更新中实际返回的模型标识；未返回则标记 unavailable，不从终端历史或 Desktop 模型设置推断。
- 轮次、原始 stop reason、消息/工具事件计数、受限错误摘要。
- 当前 Run 的预期状态路径、状态是否存在、阶段、completed_steps 数量；不输出请求全文、源码、凭据或完整环境变量。

错误摘要需要长度上限与脱敏测试；认证分类只采纳明确的错误码或结构化证据。原始 stdout 继续只用于 ACP 协议。

## Task 1：补齐最小诊断和已证实的字段契约

**文件：**

- Desktop `patches/@deepseek-ai+dsh-subagent-acp+0.1.1-rc.2.patch`。
- Desktop `test/acp-provider-launch.test.js` 及 `scripts/fixtures/acp-batch-agent.mjs`。
- DSH `plugins/dsh-pangea-companion/src/workbench-api.js`、`src/launch-log.js`。
- DSH 对应 `tests/workbench-api.test.mjs`、`tests/launch-log.test.mjs`。

1. 开工前建立基于上述提交的隔离 worktree，并核对可获取的交接补丁；不能获取的补丁只按已核实需求重建。
2. 先写失败测试：本地与远端 session ID 不同；session/new 模型有值/缺失；真实 Python 返回形状下完成步数可读；错误摘要受限且脱敏。
3. 续接提示、日志和比较统一使用 `completed_steps.length`。测试夹具使用真实 API 形状，阶段和发布版本比较继续保留。
4. 暴露已有远端会话及模型信息，接通现有日志。补充工具事件计数帮助判断停在读文件、执行命令还是模型请求。
5. 运行最小回归；不把 ACK、日志增长或时间戳变化直接当成有效分析进展。

**可验证结果：** 单次故障能够关联 Agent 会话，完成步数不再显示未知；仍不宣称 PREPARING 根因已修复。

## Task 2：验证 CodeAgent 的内部 shell

**文件：** Desktop `packages/dsh-pangea-product/index.js` 与 `test/pangea-product-runtime.test.js`，按实际环境合并位置决定是否需扩展 adapter 补丁。

1. 先测试 Windows CodeAgent 未设置、空值、已显式设置非空值，以及其他 Provider/其他平台。
2. 仅在 Windows CodeAgent 没有非空配置时传入 `CODEAGENT3_WINDOWS_SHELL_TYPE=powershell`；保留用户非空值。核实 Windows 环境变量名大小写合并。
3. 在首轮提示中明确 Desktop 提供的 Python 可执行路径；执行阻塞时要求 Agent 返回具体失败步骤并结束，不搜索宿主配置和旧日志。
4. 受控 fixture 验证变量确实到达子进程。真实 CodeAgent 验证 shell、一次命令和 run_guard init；这两层结果分别记录。

**可验证结果：** 真实 CodeAgent 使用受支持的 PowerShell，写出隔离 Run 状态。注入测试通过本身不足以宣称内网兼容。

## Task 3：使用同一 Desktop 启动链做逐段探针

**文件：** 优先复用可获取的诊断实现；如不存在，新建 Desktop `scripts/diagnose-acp-initialization.mjs` 与对应测试，复用实际 product Provider 和 LocalSubprocessRuntime。

使用独立验收目录和测试 Run。每次只启动一个 Provider，明确传入与目标 Desktop 工作区一致的 cwd 和运行时配置。每个阶段只有通过后才进入下一阶段：

| 阶段 | 行为 | 通过证据 |
| --- | --- | --- |
| 会话 | initialize + session/new | 远端 sessionId、实际模型或 unavailable |
| 文本 | 请求返回固定 ping 标记 | 本轮观测到标记，同时记录 stop reason |
| 工具 | 执行无副作用命令 | 观测到工具结果及固定标记 |
| 初始化 | 读取隔离请求与 Skill，使用明确 Python 路径执行 init | 当前测试 Run 出现状态文件，真实 runs get 返回 STEP_BOOTSTRAP |

诊断模式先禁用自动续接，以保留第一轮失败的直接证据。结束响应与稍晚到达的通知分别观测；仅在诊断器中设置有界收尾窗口，生产 adapter 不增加统一等待。

启动和各阶段均设明确超时，超时清理本探针启动的进程树。限制消息与 stderr 保留量；不采集完整宿主日志。测试覆盖延迟通知、无标记的 end_turn、RPC 错误、工具失败、超时和取消。

**分支决策：**

- 会话失败：定位启动或 ACP 协商。
- 文本失败：依据实际模型、stop reason 和结构化错误定位请求失败；不能仅靠关键词判认证问题。
- 工具失败：定位内部 shell、执行权限或工具能力。
- 工具通过而 init 失败：定位 Python 路径、请求/Skill 可读性、命令退出码及实际写入路径。
- init 通过：以相同配置进入小范围真实分析，检查原始长提示执行与后续续接。

## Task 4：OOM 独立调查

**性质：** 最多 30 分钟的首轮源码调查；产出具体嫌疑路径或证据缺口，不以未复现为已解决。

1. 原 `diagnose-opencode-env.mjs` 不在已拉取源码中，未获得源码前不声称审过，也不再次执行该脚本。
2. 若取得源码，检查输出累积、进程创建路径、事件监听与清理；只有实际发现后才提出缓存或递归启动结论。
3. 新探针为自身和子进程分开记录 PID/退出结果，限制输出保留量。基础测试覆盖大量输出和基线失败后不启动第二组。
4. 仅当正常环境基线通过，并有证据指向特定环境差异时，再做单变量对比；不再次运行无界 normal/filtered 对比，不默认提高 Node 堆上限。

## Task 5：交付可验收的独立 Windows 实例

开发侧完成依赖安装、补丁重装验证、相关测试、typecheck、构建和独立解包组装。组件清单绑定实际源码提交；提交/推送/发布按用户授权执行。

保留 .cmd/.bat 参数转发、同 session 续接与取消、真实 Windows 快照句柄、Run/attempt/session/todos 隔离和状态刷新回归。模型文案如有修改，只描述“新建 ACP 会话默认模型”，不暗示终端近期模型已被继承。

交付独立入口与最短验收流程，由用户在真实内网亲手体验。只收集版本、阶段、模型标识是否可用、错误码、退出码和状态是否落盘等必要脱敏结果，不要求完整日志或配置。

## 最终验收标准

1. NGA/OpenCode 的一次失败能够定位到上述具体阶段；实际内部原因有直接证据。若外部阻塞仍在，明确报告阻塞，不算已修复。
2. CodeAgent 真实内部 PowerShell 可执行命令，并将 init 状态写入当前隔离 Run。
3. 目标 Provider 的小范围分析能够越过 PREPARING，并继续已有 Skill 流程；正式完成仍须完整交付，ping 或 init 成功不代表分析完成。
4. 诊断器不会因晚到通知误判、不会凭宽泛词语断言认证失败、不会在基线失败后启动对比；输出和进程生命周期有界。
5. 原诊断 OOM 只有获得原因和对应回归证据后才标为解决；停用或改写探针不等于原问题已修复。

## 待查信息

均为实施中的技术问题：交接补丁是否可获取、内网实际 CLI 版本、ACP 实际模型与错误、CodeAgent 的真实 shell 结果、OOM 的进程身份。当前无需用户决定新的架构或提供敏感资料。
