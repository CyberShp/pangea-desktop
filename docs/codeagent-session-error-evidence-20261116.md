# CodeAgent 错误终态：修复边界与最小取证任务

## 当前结果

宿主现已区分“执行失败”“完成但未交付”和“结果不可读取”。执行失败优先显示 outcome.diagnostic；缺失时读取 worker.readDiagnostics().errorSummary。诊断读取失败不覆盖原错误，取消仍优先，finally 释放不变。

Desktop 的真实 ACP 适配层经子进程 JSON-RPC 模拟器验证：请求被拒绝时 stopReason 为 error，readDiagnostics 保留错误；只在 stderr 写 session.error 后返回 end_turn 时，宿主仍收到 completed。这是协议提供的信息边界，不是 CLI 已修复的证据。不能靠 stderr 关键词将正常回合一律判错，也不能将一次工具失败等同会话失败。

## 给内网 Agent 的只读任务

目标：确认 CodeAgent 1.2602.15 是否把终态错误送到 ACP 协议，以及协议字段是否足以安全判错。不要改任务状态、恢复会话、重放 prompt、执行 bind/settle/work-finish，或修改现有安装包。

1. 定位 run `dtoe-2-0-261112-01` 的任务 `671a1669-a8a3-46ad-a15d-430bac568b37` 和 `741b848b-6b3b-4236-ac62-f51baad4ca51`。从 task.json 取 owner/agent/remote session ID，按 ID 关联宿主 agent-sessions 日志，不扫描或回传无关用户内容。
2. 输出每次最后一个 prompt 的 request_id，以及同 request_id 的最后 session_update、error、turn_end 和 process_exit 元数据。重点保留 protocol_stop_reason、stop_reason、response_received、replay、error.code/message、stage 和时间；正文、工具参数、令牌脱敏。缺失字段标记缺失，不以 CLI 日志替代宿主协议证据。
3. 将上述事件与 CLI 日志 `2026-11-16T164651.log` / `2026-11-16T170226.log` 中的 session.error、finish=unknown、ConnectionRefused 时间对齐；确认 CLI 本地时间与宿主 UTC 的偏移。
4. 查找原始 session/prompt 响应（若日志保存）：究竟是 JSON-RPC error 还是 result.stopReason=end_turn。检查 session/update 是否含明确终态错误、属于当前 session/request、且不是 replay。若无原始响应，明确结论仅为间接证据。
5. 若可读 CLI 源码，提供处理 session/prompt、订阅 session.error、汇总 processor 终态并返回 stopReason 的函数及最小片段；不要回传凭据或整份业务代码。仅有 bun 可执行产物则说明无源码。

交付：两条对应关系与终态时间线、原始响应是否存在、错误事件是否跨协议、相关源码位置/不可得说明。

## CLI 修复与验收要求

在 session/prompt 对应 processor 终态为 error 时，拒绝该 JSON-RPC 请求并保留错误消息；取消保持 cancelled，正常回合保持 end_turn。绑定当前 session 和请求，避免历史错误污染新回合。禁止用 max_turn_requests 假装服务故障。

在独立测试会话中模拟模型连接失败，验证宿主收到 error 且显示连接失败；再回归正常完成、取消、max_tokens、一次工具失败后恢复成功、历史 session/load replay。此阶段需实际 CLI 源码/构建入口和隔离测试环境；当前两个产品仓库不含内部 CodeAgent 源码，不能宣称已完成其修复。

## 自动化交付证据补充

`PANGEA_TEST_COMPANION_ROOT=<锁定插件目录> node --test test/acp-injection-delivery.test.mjs` 已在 Linux 通过 6 项。覆盖真实 Companion 生成器、Desktop 带补丁的 ACP Provider/SDK、实际子进程和文件系统；只有 CLI 用确定性 JSON-RPC 模拟器代替。连接拒绝原文到达生成器，伪完成被识别为未交付；所有路径验证释放及进程退出。

Windows release 构建的非 SkipTests 路径，以及 release-pipeline-tests 的 windows-components 作业，均已接入此测试并指定锁定的插件目录。当前环境未执行 Windows 构建，不将 YAML/脚本修改等同 Windows 成品通过。

本轮 Desktop 相关测试 78 项、交付集成 6 项、test 版本升级构建目标测试 1 项通过；插件全量 1060 通过、33 跳过、0 失败。Issue 01/03 已满足本地代码验收；Issue 02 仍未满足上游修复验收。
