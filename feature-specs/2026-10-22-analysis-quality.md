# 分析质量三阶段改进

## 开发与放行

用户于 2026-10-22 授权三个 GPT-6.1 SOL High Agent 分别开发三个阶段，第四个同配置 Agent 独立验收；主 Agent 审查代码、集成和最终放行。用户随后调整推送顺序：先将当前审核版推送三个仓库的 `langgraph`，保持组件锁定一致；实际验收通过后再推送验收结论及必要修复。首次推送时实际验收仍在进行中。

已完成的输入精简作为开发基线：普通新建删除参考源码范围和流程基线；历史 Run、已冻结参考输入、恢复与定向补充保持原合同。

| 阶段 | 交付 | 关键边界 |
| --- | --- | --- |
| 一 | 源码跳转、目标透传、目标比例显示统一、主干规划职责 | 产品行为/接口契约目标显式选择并冻结；旧 Run 使用原规则；语义决定留给 Agent/Reviewer |
| 二 | 三图合同统一、格式诊断回传、原 worker 修正 | 先修合法片段被误判的问题；可消费结果保留并提示；不因警告判语义失败，不替换 worker |
| 三 | 模块总览、离线图文报告、执行条件与依据导出 | 聚合显式关系，不推测调用链；复用现有 renderer；8 列用例主表保持，另附依据表 |

## 实际验收配置

- 使用隔离的 PANGEA Desktop 测试实例，经 OpenCode ACP 发起实际分析。
- 用户确认模型：`minimax-cn-coding-plan/MiniMax-M3`。
- 目标：本机 dperf TCP/HTTP 会话与收发主干，源码提交 `4b3389e7e631cd01bd525d691832427bcf037813`。
- 选择 15 个 C 文件及相关头文件：main、config、config_keyword、work_space、client、server、tcp、socket、socket_timer、http、http_parse、eth、ip、mbuf、net_stats。
- 聚焦命令行/配置到工作线程、TCP/HTTP 收发、重传超时、连接关闭与资源回收；未冻结的 DPDK/邻居等实现边界必须如实说明。
- 冻结分析设置为 `scenario=module-analysis`、`mode=depth`、`objective=product-behavior`，用于验证 Planning、Analysis、独立复核及需要时的原 worker 定向修正。模型身份、源码哈希、冻结目标、耗时和已记录成本均保存为证据；缺失成本不能记为零。

## 验收矩阵

1. 输入与旧 Run：两项旧入口消失；源码选择/预览正常；目标与模型进入冻结合同；旧结果仍可读。
2. 源码与三图：逐条检查有效流程的三图诊断、消息/变量完整性、源码跳转、合法分支重排、原 worker 修正后的诊断更新。
3. 分析质量：对照源码判断真实入口、关键主干/异常路径和跨单元关系；不以节点数或用例数量替代质量判断。
4. 模块与报告：总览导航指向同一 Run/流程；离线报告不依赖本机服务或网络，图、文字、事实与诊断一致。
5. 用例导出：主表与附表使用相同筛选/勾选身份和顺序，原 8 列保持；执行条件与依据可核查。
6. 工程检查：相关回归、完整插件测试、受影响 Python verification、Desktop 类型检查/构建、真实框架与成品验证。

部分分析结果必须明确标注部分状态；工程验收通过不能替代 Agent 的语义裁决，也不能把 UNRESOLVED 写成已验证成功。发现产品缺陷须修复并针对性重验，最终放行以实际验收和主 Agent 审核为准。

## 当前状态

三阶段已集成并完成首次推送。真实 Run 和本轮原生、导出及离线检查已完成，独立源码核对确认分析质量未通过；完整大 JSON 的浏览器正文可读性也未验通过。验收证据位于 `runtime-validation/analysis-quality-20261022/`。第二次推送以验收通过为条件，本轮不放行。

已推送并核对的三个 `langgraph` 提交分别为 Agent `58e3be11f1607336ee4a0e54b2e9edb5c4b55efc`、插件 `79175f1ae2e5b646cce1529384b6bd9ac50c64fb`、Desktop `35d8f7c7c49b47e1792de2a5bb053bc2ec922574`。首次推送之后的修复保存在本地，当前组件锁定指向 Agent `d722daf`、插件 `6749573`。

首次推送检查点：实际 Run `dperf-tcp-http-http-261022-01` 已通过隔离 Desktop 发起，冻结并实际派发模型为中国区 `minimax-cn-coding-plan/MiniMax-M3`。源码快照包含 15 个 C 文件及 37 个头文件，52 项哈希与原始源码一致；请求中的 README/LICENSE 未纳入源码快照。164 项运行代码哈希与审核版一致。规划已完成并拆分为 9 个单元，源码分析正在执行；这些运行信息不代表验收已通过。

主 Agent 集成审核已核对并要求修正：closure 复制后仍以原 worker 和新 action 绑定有效诊断；只把显式 `main_path_ids` 显示为主干；离线报告使用同一结果快照并检查导出期间发布变化；新冻结合同的格式提示贯通读取、复核、浏览和导出；不可读取文字附件的导出降级边界。

首次集成工程验证：插件集成测试 758 通过、8 跳过、0 失败；Python 目标合同 4 项、图诊断 5 项、原生图记录 6 项、流程稳定性 8 项、流程路径提示 3 项、分支合同 5 项及报告 smoke 通过；23 份图诊断 fixture 的 Python/JavaScript 完整输出一致。Desktop 类型检查、Electron 构建通过。集成样本离线浏览器测试在下载完成后关闭服务，6 张图均加载成功，0 外部请求、0 页面错误。

Desktop 未修改产品源码的 `a23cd31` 基线全量测试为 634 通过、3 跳过、10 失败，原始日志和分类保存在 `desktop-baseline-tests.log` / `desktop-baseline.json`。失败涉及历史品牌/preload/模型选择器静态断言、飞书脚本环境及升级恢复等；不能把这组基线记录为全绿，最终验收须区分新增回归。

旧真实 Run `e2e-261021-01` 的只读对照已完成：push/pop 的时序消息均从 1/4 恢复为 4/4；两条流程的 3 个变量一直保留，数组形式 writes 的展示已恢复。未修改该 Run 的记录或冻结输入，证据为 `diagrams-before.json` / `diagrams-after.json`。

## 首次推送后的验收修复

真实 Run 暴露出旧 `flow_path_hint` 已随记录替换而失效，却仍显示在当前待处理项的问题。当前读取、完成验证、Reviewer 和报告现按同一结果内的显式替换关系区分当前提示与历史；旧压平提示只有在同 action 精确匹配退休来源且没有当前同文提示时才省去。显式 `source_warning` 必须具有匹配的类型和记录身份，缺失或冲突时保留。原始 Run、历史 warnings/degradations 均保留。只读复现中，unit3 的 4 条旧 fin-close-normal 提示从当前待处理项消失，78 条历史 degradation 保留。

该修复经主 Agent 审核及独立边界复查，插件最终回归 762 通过、8 跳过、0 失败；Python 当前警告与 closure 身份检查 7 项、观测恢复检查 12 项通过。相关日志为 `plugin-final-warning-tests.log`、`root-current-warning-final-tests.log`、`root-warning-observability-tests.log`。

CLI 合同补充 compact 完整项、片段拼接和跨 action 记录身份的读取说明，未增加工具、门禁或自动回合。此更新来自真实 Reviewer 自写整理脚本遗漏记录的观察。首次运行的 manifest 已独立保存为 `initial-run-*`，恢复运行版本保存为 `completed-run-*`，后续展示版本不替换原始生成版本证据。以上工程修复和测试不代表真实分析质量验收通过。

检查点恢复前，对照阶段曾持续重复错误的分页整理；当时首轮 9 单元和盲审均已完成，对照尚未提交结论。主 Agent 决定通过 Desktop 停止并保存检查点，更新已审核代码和 CLI 说明后续接原 Reviewer；此为显式恢复干预，须保留前后版本与会话证据。compact 游标现绑定提示投影版本，避免升级后旧游标在同 revision 下错指记录；原条件校验提示从头读取，2 项真实 Graph 分页回归通过，结果和历史未改写。

## 真实 Run 的质量验收

`dperf-tcp-http-http-261022-01` 于 2026-10-22 完成，9 个分析单元、独立盲审、对照复核及 unit4/unit6 的原 worker 定向修正均接受。Run 状态为 `complete`，质量为 `UNRESOLVED`。最终有效产物有 20 条流程、14 条风险、103 条用例。作者声明的黑盒 ready 为 76 条、灰盒 ready 为 0 条，合计 73.8%；另有 2 条接口契约用例声明 ready，因此用例表的全部层级 ready 为 78 条。标签统计不代表这些用例已经可执行或执行通过。

已记录 action 的墙钟窗口为 2026-10-21 22:57:37.154 UTC 至 2026-10-22 00:22:43.992 UTC，共 85 分 6.838 秒，包含中途恢复间隔；并发 action 耗时不相加作为墙钟。费用与 token 总量尚无可靠账目，保持未知。

恢复使用原 Reviewer task `273c2e29-5bba-48ff-936d-e8ef3d21230b` 和远端会话 `ses_e9f2e3ad7ffe7V30743oKYOyCD`；模型保持中国区 MiniMax-M3。停止前后的 12 个已有结果文件相同，恢复后完整读取的 193 条记录复合身份与独立读取一致。未给模型注入本次验收发现的语义答案，也未改写生成结果。此 Run 包含一次人工协调的检查点恢复，不作为完全无人干预成功的证据。

主 Agent 对最终有效记录及冻结源码的核对结论为**分析质量未通过**，证据为 `root-final-semantic-findings.json`。仍有以下问题：

- 用例及修正文使用不存在的 CLI 参数，如 `--server`、`--keepalive`、`-b`；真实入口是 `-c` 配置文件、`-t` 配置校验等。部分错误入口仍标 ready。
- TCP SYN-ACK 的序号与确认号混淆；同一结果对 LAST_ACK 关闭条件有相互矛盾的描述。
- keepalive 总请求数与计数器口径不符，关闭时机也被写成固定等待下一周期。
- Content-Length 不足时等待后续字节，被概括为所有长度不符均解析失败。
- 定时器尾插 FIFO 被分析与复核共同误判为头插；秒转 tick 后的除法又被错误按秒进行整数截断。
- 数据面循环的时序图把本轮批量接收的返回消息放在调用消息之前；原生显示忠实保留该作者顺序。

Reviewer 已读到并正确记录真实 `-c/-t` 入口，却未把该依据与其他单元和自己的修正建议逐条对照；其 readiness 与比例明细还存在误读。根因调查见 `stage1-final-entry-review.json`；定时器独立核对见 `stage2-final-semantic-review.json`。这些属于本次产物的源码判断问题，不能通过 UI 可操作、图格式有效、标签达到 70% 或 finding 已关闭来放行。

下一次质量修复应在现有分析/复核职责内落实实际操作语法、参数归属和判据逐项核对，并复用已经核实的入口事实。验证需要以相同 15 C/37 H、模型和设置重新跑完整链路；仅复验 unit4/unit6 的 closure 无法证明 unit3/unit5 的漏检已修复。当前未新增语义门禁或自动复核轮次。

## 最终产品回归与报告修复

独立验收已在真实 Desktop 逐条打开最终 20 条流程的流程图、时序图和调用图，并记录原始事实与部分状态。主 Agent 另将 20 条原生观察的正文哈希逐一绑定到最终有效 analysis/closure 记录，全部相同，证据为 `independent-native-three-view-coverage.json` 和 `root-final-native-flow-bindings.json`。这项检查证明宿主展示与产物一致，不证明作者的源码解释正确；未实际执行 dperf 的生成用例。

原生报告曾把资料资产数 0 当成冻结源码数。插件 `49a9bbd` 改为读取冻结清单中的源码身份，按仓库和路径去重，兼容旧清单，缺失时显示未记录。真实原生报告已复验为 52 个文件；Run、模型结果及原文字报告字节保持不变。相关 142 项测试通过。

真实 Desktop 导出的离线包有 65 个文件，包含 20 条流程的 60 张 SVG。原 HTML 为 91.85 MB，浏览器首屏和全部图约 15.3 秒加载。插件 `6749573` 将完整快照保留在包内 `facts.json`，HTML 提供本地打开入口；首页显示已有状态与数量，完整版本信息、原文和流程事实默认折叠，仍可展开。用同一真实快照重建，HTML 降为 25.03 MB、ZIP 从 147.99 MB 降为 81.16 MB；64 个非 HTML 文件逐字节相同。禁止 HTTP 的浏览器中，DOM 约 0.62 秒、60 张图约 0.66 秒加载，0 页面错误。完整 53.45 MB JSON 大样本已验证本地导航及文件完整性，未校验浏览器正文完整显示；小样本另验证浏览器打开内容一致。

最新插件全量测试 766 通过、8 跳过、0 失败，包含上述计数与离线报告回归；Desktop 组件账本与插件清理检查 15 项、打包 staging 检查 1 项通过。真实原生 Excel/CSV 导出均验证 8 列主表、2 行主表/附表身份顺序一致，包含筛选外仍勾选的用例；最终 CSV manifest 的 Run 和 final 发布身份匹配。

最后由 Desktop 实际导出的 `native-exports/final-reviewed-offline-report.zip` 为 81,159,823 字节、65 个文件，SHA-256 为 `a338b6f287b3d6052d130ff62199f7e894088a2129070e51003c071c146ec750`。64 个非 HTML 文件与原导出逐字节相同，20 条流程身份、最终 revision、原始正文及 27 条诊断保持一致。主 Agent 另检查最终 9 个有效结果文件和原 `report.md` / `report.html`，与质量审查时的哈希全部相同，记录于 `root-final-artifact-preservation.json`。

关闭本次测试服务后，最终导出包的独立离线浏览器实测为：DOM 0.627 秒、首屏截图 0.714 秒、60 张图加载完成 0.733 秒；0 HTTP 请求，首尾三类图均有截图，版本、原文及流程事实折叠区均能展开。完整 `facts.json` 链接实际导航到本地文件且完成 DOM 加载，但 53.45 MB JSON 新页截图在 30 秒超时；原始测试保留 `status=failed`。因此大 JSON 浏览器正文可读性尚未验通过，不能以文件哈希一致替代，证据为 `native-exports/offline-performance-final/offline-performance.json`。

独立验收与主 Agent 的最终结论一致：`SEMANTIC FAIL`，第二次推送不放行。完整结论见 `independent-final-acceptance.md` / `.json` 和 `release-gate.json`。本次测试 Desktop、服务与浏览器助手均已退出，用户原有实例的进程、路径和创建时间保持不变，记录于 `independent-final-cleanup.json`。三个远端 `langgraph` 已再次核对为首次推送版本；后续修复和组件锁定保留为本地提交。
