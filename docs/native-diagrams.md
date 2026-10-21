# 原生流程、时序与函数变量图

2026-10-21 起，Desktop 不再携带或调用 Archify。普通源码分析 Agent 在既有 `behavior-flow-v1` 流程记录中提供 `sequence` 与 `call_graph` 结构化事实，工作台读取同一版本的数据进行本地布局和 SVG 展示。没有独立生图会话、10/20 分钟生图预算或模型排版返修。

Agent 负责真实参与者、消息、条件分支、函数调用点、参数映射及变量读写；渲染器只计算图形位置，不补造交互或调用关系。时序数据不包含像素坐标。未知或不适用的关系明确标注，结构不完整不应阻断主分析的有效结果。

旧 Run 继续使用原冻结合同。未提供新字段的历史流程显示“本次分析未提供”，不会把节点顺序猜成时序或函数调用。已有 `派生视图/archify/` 中的 HTML、SVG 和记录继续保留；无需旧绘图引擎即可阅读已有产物。

## 构建与升级验证

- `scripts/verify-native-diagrams.mjs <companion-root>` 使用已安装 companion 读取一个合成 source-first Run，验证三种原生 SVG，以及新字段在投影中保持原值、旧流程不被补造图数据。
- Windows 成品构建在打包后调用上述检查，使用包内 Node 和 companion；不访问模型或网络。
- `scripts/verify-diagram-upgrade.mjs prepare|verify <package> <data-root>` 在补丁替换前创建一次夹具，替换后校验整份 Run（包括历史 HTML/SVG）的哈希，并只在 Run 之外写验收导出。
- `scripts/verify-release-patch.ps1` 继续校验用户本地 Skill、任务输入/结果和历史图文件保留，并检查目标包不再包含 Archify。
- `scripts/verify-flow-runtime.mjs` 保留包内 Python、Coverage 和 Skill 验收，图表部分改为三种原生渲染，并用 XML 解析器检查 SVG。

这些检查验证打包、数据传递和确定性渲染，不代替真实模型对源码的分析质量验收。组件固定提交须同时包含 pangea-agent 的数据生成规则与 companion 的展示支持。
