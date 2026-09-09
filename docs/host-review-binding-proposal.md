# 宿主独立复核与会话绑定方案

2026-09-09 用户已明确确认：“确认，开始修改，并验收”。当前正在实现及本地验收，不包含推送或发布。

实际接线范围为模块分析、覆盖率分析的五阶段深度模式，使用现有 ACP subagents 执行器；九阶段场景、内置 API 执行与历史 Run 不套用此协议。一个宿主 Job 管理生成者与独立审核者两个真实 ACP 会话，共享取消信号；宿主 TaskStore 保存绑定与回合完成证据。审核者决定修订时续接原生成者，随后续接原审核者，正式输出还需复查。

现有捆绑 ACP 适配器只提供 newSession，没有暴露 loadSession。运行中可续接原会话；进程中断后保存原绑定并明确等待恢复，不创建替代审核者，也不声称已经支持重启后恢复原会话。

## 已验证失败

实际 Desktop 的 analysis-260909-04 为 depth。Producer 在独立审查状态.json 填入 independent=true、producer_session_id=analysis-260909-04、reviewer_session_id=analysis-260909-04-Judge、semantic_verdict=PASS。实际宿主 Producer 会话为 session-1c4371ee-223b-40ae-8f3d-82fc90eb2c7d，ACP 会话为 ses_f79b3efe0ffeK8elX32jJxhWLs。启动记录只有该 Producer；该 ACP 会话工具记录没有 task/agent 调用，Shell 记录也没有模型/会话启动命令。未找到可核验的独立 Reviewer。

Companion 当前 reader 明确把这种值显示为“Agent 声明，宿主未核验”，但缺乏真正完成 depth 复核的宿主派发和绑定链路。重复补充 Skill 文案后，速度型仍出现范围及清理 Oracle 漏审，不能继续把提示词修改当作稳定质量修复。

## 最小实现边界

1. 复用 Companion 现有 TaskStore、会话创建和 workbench-api.js/startAcpJob，不新增另一套 Agent 执行器。depth 到复核阶段时显式暂停 Producer，由宿主派发一个真实 Reviewer，绑定当前 task_id、run_id、data_root、Producer 会话、Reviewer 会话和 Job。
2. 宿主记录不可由 Producer 自填的实际调用与结束证据；以宿主记录核验身份及绑定，保持分析语义、问题裁决、PASS/UNRESOLVED 由 Reviewer 负责。Python 不按关键词、用例数量或内容决定质量。
3. Reviewer 独立读取当前 Run 的目标、冻结输入和原分析；提出定向修订后续接同一 Producer，修改原产物并由同一 Reviewer 复查。不得重开整轮分析、替换 Worker 或让宿主代写用例。
4. 缺少真实 Reviewer、身份不一致或绑定缺失时，保持当前任务等待复核/修正，不冒称已完成独立审查；已有分析内容与原声明继续可见。不把语义争议判为技术失败，不因固定重试次数判死。
5. speed 继续明确显示自审；历史 Run 不追溯改写、不补造会话证据。没有宿主证据的外部导入/历史独立声明显示未核验，不把历史内容自动判失败。

## 为什么需要宿主改动

现有 Skill 已禁止伪造 Reviewer 身份，但实际模型仍自填编号。宿主本来就掌握真实会话与 Job，使用现有执行器派发、记录和续接能解决身份来源问题；继续增加相同提示不能提供真实执行证据。此方案不把语义决定权转给代码。

## 可能误拦与处理

外部 CLI 独立复核、历史 Run 迁移、宿主重启丢失当前会话可能缺少可核验证据。此时保留原结论并显示未核验/待恢复；仅新的宿主管理 depth Run 要求完整绑定后继续交付。取消、重启恢复必须只关联已保存的 exact task/run/session/job ID，不通过目录或最近会话猜测。

## 验收

- 使用实际 Desktop 和同一最小源码/覆盖率输入，新建 depth Run，产生两个真实且不同的会话，过程及调用记录可见。
- 刻意提供可构造的错误 Oracle，由 Reviewer 找到源码反证，原 Producer 定向修订并复查；不使用机械语义检查代替。
- Producer 自填假 Reviewer ID、ID 属于其他 Run、宿主中断和取消时不显示独立复核已完成；原内容保留，可恢复至同一绑定执行。
- 合法独立审查可继续；非致命内容不一致只提示；身份/绑定或安全边界错误才等待修正。历史和 speed 场景保持真实标签。

## 确认范围

本方案涉及新增复核阶段 action 自动化及宿主身份绑定校验，超过本轮已经完成的解析器和提示文案修复。pangea-agent/AGENTS.md 要求此类改动先说明行为、误拦风险、权限边界并得到用户明确确认。确认仅授权上述最小宿主实现与本地验证，不包含推送、合入或发布。
