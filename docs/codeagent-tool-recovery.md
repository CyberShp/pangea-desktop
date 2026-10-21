# CodeAgent 工具终态缺失与恢复

## 2.0.18 现场证据

现场快照包含 208 条已收到且被 SDK 接受的工具事件，校验、采集错误和证据淘汰均为 0。四个 edit 工具各只有一次 pending，rawInput 为空，未观察到执行中或输出。该证据表明采样边界没有收到这四个 ID 的后续状态；不能证明工具未执行、成功或已取消。占位事件遗留、权限处理后漏通知、后续通知换 ID 等原因仍需 CodeAgent 侧证据区分。

2.0.18 的宿主等待同 ID 终态后才允许恢复。若执行器不补终态，任务会持续暂停；该版本的诊断增强并未修复执行器漏通知的根因。

## 恢复边界

- 仅 CodeAgent 的真实 `session/prompt` 正常 `end_turn` 后，才尝试此恢复；正在执行、取消响应、协议错误不触发。
- 保留原 pending 和诊断证据。空输入、正常回合结束或根 PID 退出均不作为工具成功证明。
- 先停止宿主持有的旧 worker，并取得受管进程停止的显式证明。Windows 需要启动时建立的私有 Job Object；无法建立或验证归属时保持暂停。
- 停止确认后读取当前 action 的保存结果。完成声明必须匹配当前 revision 才可进入 Graph 验证；否则仅恢复原 task/remote session，先读结果和临时文件，再继续未完成部分。
- 每个 action 最多一次自动恢复。清理超时、证明失败、结果读取失败、无法恢复原会话或第二次未闭合均保留结果并暂停。
- `session/load` 的历史通知保留在会话记录中，不重新计为当前活跃工具或新输出。
- 就绪回合若出现未闭合工具，暂停并阻止正式任务清空旧状态。

这里解决的是宿主缺少有界恢复路径的问题，不宣称修复 CodeAgent 内部漏发工具终态。

## 验证入口

Desktop 定向测试：`acp-diagnostics.test.js`、`acp-provider-launch.test.js`、`windows-recovery-fence.test.js`。前两项通过真实 ACP 管道运行受控执行器；Windows 原生 Job 测试必须在 Windows 上执行，已纳入 Windows 构建检查。

Companion 定向测试：`acp-progress.test.mjs`、`acp-recovery.test.mjs`、`source-first-acp.test.mjs`。覆盖保存结果直接验收、同会话续接、失败和超时不放行、取消竞态及就绪阶段保护。
