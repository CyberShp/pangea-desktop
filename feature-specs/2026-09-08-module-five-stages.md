# 模块分析五阶段减负

## 范围和基线

基于 2026-09-08 fetch 的 codetalks-skill：Agent 08bdd37、DSH 909bafa、Desktop 471b32a。实现分支 feat/module-analysis-five-stages；不包含覆盖率分析新场景或 Archify，不恢复 Graph/action/settle。

原 manifest 的固定成本：九步、19 份编号过程文档、7 份覆盖门禁、逐流程 12 章节/2200 字要求和 8 份正式报告。本文不推测这些成本占真实耗时的比例。

## 合并后的产物

| 阶段 | 主产物 |
| --- | --- |
| 01 输入与范围 | 活文档/输入与范围.md；现有输入材料索引、方法论选择、运行计划 |
| 02 模块盘点 | 活文档/模块盘点.md、分析台账.md；入口/流程/分支/状态/资源稳定 ID |
| 03 按流程完成分析 | 活文档/流程讲解/流程-*.md；共用风险点与SFMEA.md、黑盒测试用例.md；同一分析台账及阶段投影 |
| 04 复核与定向修订 | 活文档/复核记录.md；独立审查状态；原工件定向修订及投影更新 |
| 05 正式交付 | 正式输出/风险点与SFMEA.md、黑盒测试用例.md（发布已审原文）；完整分析报告.md（摘要、相对链接索引、限制） |

六份共用活文档加实际流程文档。运行计划只保留流程队列和恢复游标，不复制分析正文；分析台账合并所有维度覆盖及处置；风险/SFMEA 共用 risk_id；用例以 Flow/Branch/Risk/Evidence ID 追溯。任务交接是现有 guard 生成的恢复入口。保留六类内部 JSON，不增建生命周期或语义校验器。

正式交付单位是完整 Run；报告链接 Run 内已审流程、台账和复核记录，单独发送汇总 Markdown 不等于完整交付。

## 兼容与宿主

- Skill 1.4.0 的模块 manifest 为五阶段。其他场景从 legacy-workflow-manifest.json 选择九步合同，冻结为该 Run 的 workflow-manifest.json；不扩展其他场景。
- 历史 Run 保留自身冻结 Skill、manifest、状态和编号，不迁移、不重写。Reader 读取冻结 manifest 的阶段；无 manifest 的早期 Run 保留现有九步显示兼容。
- 新建入口要求当前 Skill 1.4.0；历史只读读取不走新建能力判定。
- Python API 返回当前 Run 的 workflow；ACP 启动/续接提示不再写死 01–09 和 /9。Companion 标题、数量、工件归属、复核和最后阶段从 manifest 读取。
- 新模块资产 allowed_steps 使用阶段 01–04，支持 Producer/Reviewer 回查冻结材料；其他场景和旧 Run 不改写授权。
- 恢复沿用 init --resume、start-step、progress 和 handoff。同一 current_step 重入不重置进度/耗时；复核阶段修订原文件并发布，不重开已经完成的阶段。
- 时间固定 UTC+8。源码继续单遍复制到 Run，不增加源码哈希或复验。

## 判断责任

模块路径不执行固定字符数、章节或关键词质量检查。保留已存在的身份、可读取工件、状态顺序及投影结构契约；脚本不能判断分析是否深入、某分支是否适用、风险是否成立或 Reviewer 是否真为独立执行。深度型仍要求独立复核，UI 对身份信息保持“Agent 声明、宿主未核验”，不以 READY 当作语义 PASS。

交付完整性沿用现有用例字段检查；模块交付缺项不把阶段或 Run 标为 complete，保留原文件等待同一 Agent 修正。未决语义、范围限制与未分析工作在台账和报告分别呈现，不由 Python 根据正文猜测。

## 验证与边界

scripts/verify-module-workflow.py 使用真实 create_skill_run、冻结 guard 与临时 Run，覆盖短文五阶段、复杂工件与游标恢复、定向修订、自审声明不能通过深度复核、未完成交付原地修复和其他场景九步兼容。已接入 Windows 组装使用的 Python 验证阶段。

Companion module-workflow.test.mjs 覆盖五阶段草稿/正式投影、用例导出、真实进度、复核标题、未 finalize 不标正式交付，以及旧九步 Run 只读兼容。其他既有读写、启动/续接测试继续运行。

以上是确定性工程回归；复杂正文为合成夹具，不是实际模型分析结果，独立审查 JSON 为测试数据，不能冒称真实独立 Reviewer 验收。真实 Windows/内网模型仍需验收复杂流程分析完整度、compact 后行为、复核质量和实际 UI 交互；没有测量提速百分比。

本地验证：五阶段回归 7/7；源码复制回归 6 通过、1 项真实 Windows 文件句柄测试按平台跳过；Companion 全量 137/137（含长阶段内进展不误判续接停滞）；Desktop typecheck 和 Electron Vite build 通过。Agent 本地测试 14/14；其中旧性能夹具的范围文件名已按新合同更新，遵循该仓库 tests/ 不提交规则，仅保留本地；可提交的组装验证脚本也覆盖阶段耗时及工件字节增量。

Skill authoring 通用 quick_validate 不通过：本项目原有 frontmatter 的 version/derived_from 不在该工具允许列表中，保留项目元数据合同。项目自己的 Skill 冻结、读取和运行回归通过，不能将通用校验说成通过。

组件锁指向上述功能分支的本地提交；未推送前不能从远端组装此组合。本轮不触发远端构建或发布。

Desktop 发布/组装契约测试 6/6。全量测试为 420 通过、13 失败、3 跳过；在独立工作树检出原始 471b32a、使用同一依赖重跑，结果相同，13 项失败也相同：branding-patch、directory-picker、feishu-release-notes、lan-mobile-bridge（8 项）、lan-mobile-tunnel、market-installer。未修改这些基线失败的测试或生产代码。
