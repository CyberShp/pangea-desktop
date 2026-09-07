# Windows ACP 初始化诊断与本轮验收

本轮实现位于三个仓库各自的 `codex/windows-acp-initialization` 工作区，基于 2026-09-07 拉取的 `codetalks-skill`。Desktop 和 DSH 有未提交修改；Agent 保持原提交。

## 已实现

- Companion 统一读取 Python 返回的 `completed_steps.length`，修正续接步数和无进展比较的字段契约。
- ACP 日志分别记录本地、远端会话 ID、Agent 实际返回的模型或 `unavailable`、回合停止原因、消息与工具事件计数、RPC 错误码和受限错误摘要。计数为会话累计事件数，工具失败是失败通知次数，不是去重后的工具数量。
- stderr 使用现有 subprocess 尾部收集器，保留 8192 字节。OpenCode ACP 增加 `--print-logs`，默认日志级别 ERROR；保留已指定日志级别。日志写盘前遮盖 URL、Bearer/Basic 和常见凭据字段，单字段最多 8192 字符。
- Windows CodeAgent 仅在 shell 变量不存在或为空时默认 PowerShell；非空值及大小写键名保留。提示词提供 Desktop Python 路径，要求宿主阻塞时报告并结束。
- 创建分析、执行器设置和产品设置页均明确：外部 Agent 使用新建 ACP 会话的默认模型。
- 探针依次检查 session、ping、tool、init。失败即停，不自动续接失败阶段；工具阶段要求 ACP 工具输出包含标记，init 阶段要求真实状态文件和 Python API 同时通过。

## 日志与诊断增强（2026-09-08）

- 任务概览的折叠「启动诊断」显示远端会话、ACP 握手返回的 Agent 版本、模型、停止原因、最近工具 ID/状态、回合耗时、首个通知耗时、Run 状态文件、错误摘要和 stderr 摘要。右侧执行消息也使用相同字段。首个事件指任意 ACP session/update，不等于首个模型文本。
- 进程清理后另记 `acp_process_cleanup`，区分清理完成时的退出码与回合结束；清理后的 exit 0 本身不能证明模型或工具成功。缺失版本或退出码不补猜测值。
- stderr 记录总字节偏移及是否丢弃前部；探针输出超过尾部上限时明确标记。工具内容按回合清空，计数仍为会话累计通知数。
- 任务日志查询最多读取文件末尾 256 KiB、返回最多 200 条记录，并提示截断；不再把历史 JSONL 全部读入内存。这是独立修正，不是原环境对比脚本 OOM 的根因结论。
- 探针在阶段开始、阶段结束、子进程启动/退出和清理时同步写入 `events.jsonl`。每条阶段事件带 UTC 时间、累计耗时、探针 PID 和探针自身 RSS/堆快照；这些不是外部 Agent 的内存统计，也不是峰值采样。
- 正常完成后写 `report.json`；异常退出时先查看已落盘的最后事件。失败回合另附最多 512 字符的脱敏回复/工具文本，帮助区分「无标记回复」与工具失败。日志不能保证遮盖任意形式的敏感文本，回传前只保留与失败相关的必要字段。

PowerShell 包装脚本默认在系统临时目录生成唯一诊断目录，并打印路径。可加 `-OutputDirectory 'D:\diagnostics\acp-run-01'` 指定新目录（父目录须已存在）；已有目录会拒绝写入。直接调用 Node 时使用 `--output-dir` 开启持久记录；省略时仅输出控制台 JSON。

本次增强验证：ACP 相关测试 17/17（含真实嵌入 Python 初始化、持久记录、拒绝覆盖、超时回收）；Companion 全套 124/124（含大文件尾部读取及界面当前任务/当前尝试隔离）。

增强后的包内真实 OpenCode 1.18.28 全探针于 2026-09-08 本地时间通过，耗时 74.166 秒；session/ping/tool/init 分别约 2.7/18.6/20.0/32.1 秒，形成 21 条持久事件，状态文件为 STEP_BOOTSTRAP，清理后进程 exit 0。本地证据在 `deliverables/opencode-logging-ca45f17a/`。Windows 三 Provider 模拟批处理、续接、取消均通过；类型检查、开发包组装及补丁原始包应用检查通过，开发实例 HTTP 200。上述结果均不替代真实内网验收。

## 独立开发实例

源工作区：`D:\pangea-source\pangea-desktop-windows-acp`。

启动 `scripts\start-acp-dev.ps1`，或打开 `dist-dev\win-unpacked\PANGEA Desktop Dev.exe`。本轮启动脚本使用 `.pangea-build\dev-profile`，工作目录为开发包的 `launch-root`。原 `D:\pangea-desktop` 安装和用户数据没有被更新。

完整复制 `dist-dev\win-unpacked` 才能运行。该目录是开发验收包，更新功能关闭。`resources\pangea-manifest.json` 记录基线提交及有修改的源码摘要；它不是已发布或已推送版本。嵌入 Python 为原安装 3.12.10 的只读复制，Agent 源码来自本轮固定基线并包含清单记录的本地资产修复。

## 内网最短验收

在 PowerShell 中运行包内脚本，每次只检查一个 Provider：

```powershell
$app = 'D:\PANGEA-ACP-Dev'
$workspace = 'D:\目标Desktop工作目录'
& "$app\resources\app\scripts\diagnose-packaged-acp.ps1" `
  -AppDirectory $app -Workspace $workspace -Provider pangea-opencode
```

依次将 Provider 换为 `pangea-nga`、`pangea-codeagent`。Workspace 必须使用目标 Desktop 实际启动 ACP 的目录，不能任意换目录后直接比较结果。若 Desktop 自定义了 Agent 命令，追加 `-DesktopUserData '实际Desktop用户数据目录'`，脚本只加载其中现有 ACP 命令设置。没有保存过命令设置时省略该参数，使用默认命令。已有非空 `PANGEA_ACP_RUNTIME_CONFIG` 也会沿用。默认每阶段 60 秒，可用 `-TimeoutSeconds 120` 调整诊断期限。

每次 init 都在系统临时目录新建 `pangea-acp-probe-*`，通过真实 API 冻结一个只有 `probe.c` 的测试 Run，原工作区 Run 不会被初始化或覆盖。临时目录保留以便检查；路径在结果 `scratch` 中。

只需回传 provider/version、失败 phase、timedOut、stopReason/protocolStopReason、模型是否可用、事件计数、errorCode、经确认的短错误摘要，以及 state.exists/state.phase。无需完整日志、配置、凭据或二进制。PID 是启动器 PID，批处理模式下不能当作最末级 Agent PID。

## 本轮验证结果

| 验证 | 结果 |
| --- | --- |
| 真实本机 OpenCode 1.18.28，包内 Node 24.9.0/Python 3.12.10，Desktop `launch-root` | session、ping、tool、init 全通过；模型 `opencode/big-pickle`；状态 `STEP_BOOTSTRAP`；4 个受控子进程均 exit 0 |
| 真实本机 OpenCode 20 秒文本探针 | 超时；之后 60 秒期限测试通过。不能由首次超时断言认证失败 |
| 新增与相关 ACP 测试 | 17/17，包括延迟通知、无标记 end_turn、RPC 错误、失败工具、输出尾部上限、超时清理和真实 Python init |
| Companion 全套 | 123/123 |
| Sidebar 全套 | 23/23 |
| Windows 包内批处理验收 | 3 个 Provider 的模拟 `.cmd/.bat`、特殊字符、同会话续接、取消、CodeAgent PowerShell 变量到达子进程均通过 |
| 快照验收 | 7/7，包含真实 Windows 目录句柄占用 |
| Agent 阶段发布 | 6/6 |
| Desktop 类型检查、构建、Windows 解包组装 | 通过；独立实例 Harness 就绪，HTTP 200，实际页面已检查 |
| 两个更新后的依赖补丁 | 在原始 npm 包上 `git apply --check` 通过 |
| Desktop 全套 | 419 通过、6 失败、2 跳过；6 个失败在未修改基线复现 |

基线失败涉及：旧 Harness 品牌断言、目录选择器 preload 字符串断言、市场安装器 preload 字符串断言、3 项 Feishu 发布检查（其中两项依赖本机不可用的 `python3` 命令）。不能称 Desktop 全套全绿。详细命令结果保留在本地 `deliverables`。

## 仍需真实内网证据

NGA/OpenCode 的内网 PREPARING 根因尚未证明。当前本机 OpenCode 越过初始化，不代表完整九步分析已通过，也不代表内网已修复。真实 NGA、CodeAgent 未安装于本机；PowerShell 变量传递测试不等于 CodeAgent 内部 shell 验收。

原 `diagnose-opencode-env.mjs` 不在已获取源码中，本轮没有执行它。其 OOM 发生在哪个进程及具体原因仍未知。新探针记录自身和子进程 PID/退出结果，限制保留的输出尾部，并设置阶段超时；这些措施不限制外部 Agent 自己的堆，也不能证明原 OOM 已修复。生产 adapter 没有新增全局等待，普通分析输出保留规则保持不变。

内网探针若 init 通过，再用相同配置做小范围实际分析；若某阶段失败，依据该阶段的直接证据决定修改，继续保留现有凭据过滤和 Skill 生命周期。
