# 多任务小模块资产验收（2026-09-08）

后续根因与复验更新：已确认用户原 profile 默认是 MiniMax，上轮失败来自独立测试 profile 未配置它。现已通过 MiniMax 在内置方法论入口真实生成并导入候选，并移除 DeepSeek 官方 API 配置入口，见 [资产消费与模型路由复核](model-routing-and-asset-consumption-2026-09-08.md)。以下保留当时的验收记录。

本轮使用独立 PANGEA Desktop Dev，通过真实 Desktop → OpenCode 1.18.28 ACP 启动，速度模式、默认模型 opencode/big-pickle。三个任务的完整九步和文件出口通过；两份报告的因果证据复核不通过，内置方法论生成仍受缺失凭据阻塞，不能将整体验收标成全部通过。

## 任务与完成证据

| 模块 | 源码 | 所选资产 | 九步 / 正式文件 | 生成用例 | 分析耗时 |
| --- | --- | --- | --- | --- | --- |
| clamp | 8 行单函数 | 需求、设计、历史缺陷、参考资料、Coverage、用例示例 | 9/9、8 份 | 10 | 28.3 分钟（本轮续接起算） |
| is_even | 4 行单函数 | EVEN-REQ-01 需求、EVEN-DESIGN-01 设计 | 9/9、8 份 | 10 | 19.3 分钟 |
| signum | 4 行单函数 | SIGN-REF-01 参考、SIGN-BUG-01 历史缺陷、SIGN-CASE-01 用例 | 9/9、8 份 | 8 | 33.6 分钟 |

| 模块 | Task | Run | ACP 远端会话 |
| --- | --- | --- | --- |
| clamp | task-20260907162125-8532bf | src-clamp-c-clamp-260908-01 | ses_f83397a8cffeqTZUi0gmldCfpX |
| is_even | task-20260907164948-a6f562 | is_even-src-is_even-c-sk-260908-01 | ses_f83394514ffeCHbfmuhg50T0lo |
| signum | task-20260907164950-9b8361 | signum-src-signum-c-skil-260908-01 | ses_f83393cc2ffeJ5xRKxX0IMy9pL |

每项源码快照只有对应文件，资产 manifest 精确等于任务所选 ID。clamp 保留此前冻结的设计第 2 版，另两项使用独立合成资产。三项并行，均到达 complete、final 投影、运行校验通过；ACP 工具调用分别为 133、131、156 次，工具失败均为 0，退出码均为 0。

共 24 份正式 Markdown 报告、28 条生成用例、6 份 CSV/XLSX 导出。这不代表已编译并执行这 28 条目标代码测试。极小源码仍需 19–34 分钟，九步文档最低篇幅与反复编辑带来固定开销，本轮没有继续增加分析任务。

## 本轮修复与回归

- 首次方法论生成：Python 已写 task.json，但返回 task 缺少 task_path，导致 KeyError。补回响应字段，保持磁盘严格结构不变。
- 方法论失败仍显示 queued：资产插件没有订阅现有 handleAgentStatus / handleAgentError；接回真实事件。随后发现磁盘 pending 又覆盖当前失败结果，修复为优先返回当前会话终态。没有新增持久化失败格式，不能承诺重启后仍保留内存错误。最终实例真实请求明确返回 failed 和缺凭据原因。
- Windows 方法论冻结：Markdown 写入将 LF 转为 CRLF，SHA256 却按 LF 字符串计算。改为写 UTF-8 原始字节，真实失败回归转绿。
- 用例导出执行字段为空：旧读取器只识别一级标题、每文件单用例，实际 Skill 使用合并草稿、二/三级标题、中文冒号和表格。扩展同一读取流程识别多用例、单行多字段、加粗标签、输入/观测格式和表格，按 ID 去重，保留旧格式兼容。
- 导出风险 ID 误识别：R- 正则把 BR-01 分支 ID 截为不存在的 R-01。加单词边界并回归验证，最终导出所有风险 ID 都存在于实际投影。

各问题均先复现再修复。最终 Agent 17/17、资产插件 14/14、Companion 126/126；没有据此声称整个 Desktop 测试套件全部通过。修复已同步独立解包实例并重启加载，原安装目录未修改，修改未提交推送。

## 下载与文件落盘

三个模块均通过最终运行实例的真实 HTTP 导出，检查 CSV/XLSX 单元格完全一致、ZIP 完整、用例 ID 唯一且数量正确、步骤和预期非空、关联风险 ID 存在。

浏览器真实点击下载的最终文件为：

- C:/Users/sr1shepard/Downloads/pangea-is_even-src-is_even-c-sk-260908-01-test-cases (1).csv，1651 字节，与最终 HTTP 导出逐字节一致。
- C:/Users/sr1shepard/Downloads/pangea-is_even-src-is_even-c-sk-260908-01-test-cases (1).xlsx，11251 字节，单元格与 CSV 完全一致。
- C:/Users/sr1shepard/Downloads/asset-260908-007-failure.json，304 字节，asset_id 正确，last_error 为 File is not a zip file。

此前下载事件超时不能等同于未下载。初始空字段 CSV 与旧下载文件保留供对照，没有覆盖个人文件。

根因补查：页面“关联风险 5”的值来自 client.js 的 linkedCases，统计的是有关联风险的用例数，而不是去重风险数。实际 5 条用例关联到 3 个风险。这里是标签与统计口径不一致，不是导出或投影仍有多余风险；先前将其判断为数据差异不准确。该展示标签尚未修改。

## 方法论验收边界

内置 UI 方法论会话实际报 MISSING_CREDENTIAL：开发实例内置 DeepSeek 未配置 API 凭据，不能计为生成成功。最终失败与错误显示已验证，证据为 multi/methodology-ui-failure-final.json；OpenCode 分析使用自身已有可用配置。

另通过 Desktop 相同配置的真实 OpenCode ACP 执行同一个 methodology-worker，生成候选 sign-via-magnitude-division；公共 complete-derivation 命令通过 schema 和来源资产校验并导入。浏览器启用、停用成功；生产冻结函数验证候选不入选、启用入选、停用后新快照排除、旧快照不变。最终候选保持停用。此项是 Worker 和管理/冻结链路补验，不等于内置 DeepSeek 按钮生成通过，也没有新增第四个完整分析 Run。

辅助 Worker 脚本在结果写出、ACP dispose 完成后错误调用 context.dispose()，退出码为 1，未保存摘要。已改为 context.fiber.dispose()，没有重跑或重写模型结果；生成依据是真实 result.json 和公共接口校验的 completion，不能声明该辅助脚本整次运行通过。原冻结失败目录 multi/methodology-freeze-enabled 保留，修复后使用独立 *-fixed 目录。

## 分析内容复核未通过项

is_even 最终报告仍将“避免 abs(INT_MIN)”设计说明推导为当前取余奇偶实现的 High 风险，并假设取余符号或整数位宽可导致奇偶判断错误。同一 Agent 的 Step 08 自审没有纠正。余数符号不影响其是否为零；除数为 2，商可表示，不能套用除零或 INT_MIN/-1 溢出机理。参考 [SEI CERT 的 C 余数规则](https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/recommendations/integers-int/int10-c/)。该项因果证据验收不通过。

clamp 最终报告仍把 value > maximum 改为 >= 作为上界回归的例子。但等于上界时两条路径都返回相同的 maximum/value，单独该变化不会造成所述错误。该历史缺陷推导不成立，因果证据验收不通过。

signum 区分当前比较实现与历史除法实现，明确当前代码没有该除零/绝对值溢出机理；维护回归风险按此限制理解。本轮为速度模式、同一 Agent 自审，不是独立第二模型审查，也不保证所有报告语义完全正确。阶段原稿保存在 multi/quality/，正式报告保留在真实 Run，未手工修改 Agent 报告来伪装通过。

## 证据位置与剩余范围

证据根目录：.pangea-build/asset-acceptance-0908/multi/。

- launch.json：实际创建、启动结果和资产。
- status.json、delivery-verification.json：九步、正式文件、源码/资产隔离、退出码、耗时和内容判定。
- exports.json、export-file-verification.json、browser-download-verification.json：最终导出与本机落盘核对。
- methodology-completion.json、methodology-*.json：Worker 结果导入、启停及内置生成失败。
- downloaded-failure.json、is_even-before.csv、quality/：失败记录和修复前/内容问题证据。

资产选择、版本冻结、失败记录下载、方法论候选启停和冻结、任务隔离、完整流程及文件出口均有本机证据。内置方法论生成的凭据阻塞、两份报告因果错误、页面关联统计标签错误仍是未通过项。真实内网 NGA/OpenCode PREPARING、CodeAgent 内部 PowerShell 效果、原诊断 OOM 仍未获得实机闭环。
