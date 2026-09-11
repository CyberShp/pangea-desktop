# PANGEA Langgraph 配套版本

2026-09-10 抓取并合入两个仓库的远端 `codetalks-skill`：Desktop 基线
`5a3e2a9`，DSH 基线 `1f819d3`。三个仓库统一使用 `langgraph`。
固定配套提交以根目录 `pangea.components.json` 为准：

| 组件 | 分支 | 固定提交 |
|---|---|---|
| pangea-agent | langgraph | a92877f810ec93e8b5f79ffe16c86b1a0fba5e85 |
| dsh-pangea | langgraph | 714c2de83eb3984075804d5e549de826e44be033 |

Desktop 加载最新产品导航、companion 和 report-policy，打包 Agent 的 `.agents`、
`.opencode`、Python 源码与 schemas。组装检查核对固定提交、source-first 接口及
OpenCode 必需文件。启动器和插件均须来自当前配套工作目录。

## 界面与协议

侧栏提供工作台、PANGEA 分析、测试资产。分析页提供概览、业务流程、风险、
测试用例、运行过程、复核六个入口，支持流程阅读、关联跳转、搜索、冻结源码
预览、讨论草稿、报告打开及 CSV/XLSX 导出。

DSH 根据 Agent 能力选择协议，source-first 保留 Graph 调度和独立 Reviewer，
任务与 Run、宿主 Job 与启动时间分别绑定。原始业务编号用于显示，分析单元和
record_id 用于关联定位，导出保留原文。

资产管理对当前 semantic 引擎提供列表、导入、解析、审核和归档。导入预览及
摘要复核在宿主完成。恢复、元数据编辑、新修订、逐条审核受 Agent 能力限制。

## 验证结果

- Companion：211 项检查，210 通过、1 跳过，包含真实 Python CLI 集成。
- 资产插件：21 项检查，20 通过、1 跳过；产品导航：25 项通过。
- Desktop：15 项相关检查通过，Node 类型检查与构建通过。
- 独立 Desktop profile 实跑 `sample-c-260910-01`：OpenCode ACP / MiniMax M2.7，
  上下文预算 204800，Run 为 complete/PASS，宿主执行状态为 completed。
  分析与两轮 Reviewer 调用均已结算，报告落盘。
- 页面显示六个分析入口、1 条风险、3 条用例和业务流程；CSV/XLSX 实际下载成功，
  内容包含业务编号、分析单元和原始正文。资产列表、文件预览导入实测成功。
- 验收证据保存在本机 `.pangea-build/semantic-validation/latest-baseline/`。

这是单个加法函数的接入验收。大型仓库分析质量、Windows 便携包运行、DSH 内置
API 模型实跑、完整资产语义提取仍待专项验证。两个跳过检查涉及当前环境未提供的
外部执行条件，不能视为通过。

## 本地测试环境

工作目录：`/Volumes/Media/pangea-desktop-semantic-adaptation` 和
`/Volumes/Media/dsh-pangea-semantic-adaptation`。

隔离配置及验收数据位于 `/tmp/pangea-semantic-desktop-validation/`。开发测试实例
通过该目录的 `start.cjs` 启动，使用独立 appData 和日志目录，插件路径指向上述
配套工作目录。本地组件提交尚未推送；GitHub 构建前需先推送固定 DSH 提交与
Desktop 分支，再执行现有构建工作流。

## a92877f 源码交接适配验收

2026-09-12 同步 Agent `langgraph` 到 `a92877f`，DSH 增加冻结源码预读、
`next_read` 分页续读和 `pangea_result_supersede` 局部 edits。CLI 集成覆盖
101 行连续分页、原文历史保留、幂等重试、匹配失败不写入和两轮复核结算。
Companion 210 项通过、1 项跳过；Desktop 15 项相关检查通过。

独立 Desktop → OpenCode ACP → MiniMax M2.7 实跑 `sample-c-260912-01`：
complete/PASS，宿主 execution_status=completed，reader_health=ok，正式报告
可读；包含 1 条流程、1 条风险、3 条用例。当前加载的分析/复核规则和 OpenCode
插件已核对与目标 Agent 文件一致。证据位于
`.pangea-build/semantic-validation/a92877f/`。

真实模型样例证明交接和复核链路；局部 edits 的成功、重试、失败保持原文由真实
CLI 集成夹具验证。尚未执行 Windows 安装包或 DSH 内置模型的专项验收。
