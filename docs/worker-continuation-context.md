# Worker 续接提示与输入超限修复（2026-10-22）

## 报告与证据边界

用户报告 unit3 在重读 frozen rubrics 后收到“身份绑定已完成，现在执行下面的正式任务”，随后出现 `max input is 169984, current is 186265`。当前环境没有该内网 worker 的原始会话日志；以下结论来自当前 langgraph 源码与隔离回归，不等同于对该次现场时间线的完整取证。

- Companion 的 `runAction()` 对首次派发、同 action 修复和原 worker 新阶段均使用首轮 `workerPrompt()`，所以该文案再次出现不代表重新创建了身份。
- Graph 将未完成 action 返回为 `continue_agent` 时，宿主会再次注入完整引导，其中包含读 CLI 合同、task-open 和冻结规则的要求。内部 transport recovery 使用短提示，但这条 Graph 续接路径未做区分。
- 驱动 `continuePrompt()` 通过 `turn.then(...)` 串行发送，宿主也等待回合返回后才 settle/next。仅凭界面文字不能认定新提示在前一个工具执行中并发插入。
- 原代码在检查本轮超限错误之前处理“completed 且零工具调用”。模拟执行器第 1 轮返回 completed、toolCalls=0、errorSummary=Payload Too Large，第 2 轮清除错误，实际得到 2 次 prompt、1 次 settle、0 次 INPUT_TOO_LONG 事件。
- 示例短路径的首轮提示约 2,000 字符。不能将现场超出的 16,281 全部归因于该提示本身；累计历史、源码/规则输出及重复读取需要结合现场日志分解。

## 行为变化

1. 新 worker 首次执行仍获得完整引导。
2. 同一 action 的修复/恢复只收到短续接：当前身份、result-read、revision、最多 1,200 字符诊断，以及从未完成部分继续的要求。复用已读取的相同冻结版本。
3. 同一 worker 进入新 action 时收到短阶段任务：task-open 获取新阶段合同与冻结版本，保留 comparison 的必要裁决要求，使用新 action 的结果身份。
4. 持久化 `last_prompt_action_id`，宿主重启后仍能区分同 action 续接。旧绑定没有此字段时读取当前 task-open，不重发首轮引导。
5. 本轮超限优先于零工具补发和自动恢复。暂停原 action，保留原会话和有效结果，不空 settle。
6. 每个宿主提示记录 `phase`、`prompt_chars`、`prompt_bytes`，提示准备事件记录 `prompt_kind`。这些是本次宿主提示体积，不是执行器完整模型输入的 token 数。

本次不修改 Python 语义合同、不自动删除历史或切换 worker，也不改变已有未确认工具与进程树确认机制。已超限的现场会话仍需在原执行器完成上下文压缩后再续接；本修复不会追溯压缩既有历史。

## 验证范围

回归覆盖同 action 修复、新阶段 comparison/closure、持久绑定恢复、旧绑定兼容、输入超限优先处理、取消和进程树确认，以及会话/启动日志保存。真实 Python Graph 使用隔离数据目录验证 depth、speed、closure 与 2,000 文件范围，模型/ACP worker 由测试替身提供；不声称已复现内网模型行为。

验证结果：source-first-acp、acp-progress、acp-recovery 共 69 项通过（含 4 项真实 Python Graph）；agent-sessions 与 launch-log 共 23 项通过。后两组首次执行因隔离工作树缺 ssh2 未启动，复用已有依赖后重新执行通过。最终提示日志修改后定向回归 9 项通过。

Companion 提交：`a194586021a24a30394e6085b8edf3e1e64030b7`。Desktop 同步组件锁定到该提交；本地验证未触发发布构建。
