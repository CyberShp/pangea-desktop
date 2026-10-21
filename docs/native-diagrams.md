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

## 2026-10-21 字段错配与不完整显示修复

用户报告七条流程仅主干时序图部分可见，消息缺 ID、片段无法识别，函数调用端点、变量所属函数和 notes 类型不符合预期。已核实：生成规则文末的“不要用 from/to”未限定业务流程 edges，与嵌套时序消息及函数调用必须使用 from/to 存在歧义；渲染器会丢弃无 ID 消息，并隐藏无法确认片段的关联消息。未拿到该批原始 JSON，不能断言缺字段来自何种别名，也不能将合成测试称为已补齐用户历史分析。

- Agent 规则明确两种端点字段所在层级，补充 notes、ID、label、kind、分支、函数引用的自检；现有 analysis/comparison 回合逐条核对 main/sub flow 与各 paths 的交互边界。未新增 schema、门禁、自动修复或绘图会话，旧 Run 的冻结规则保持不变。
- 显示层只读兼容明确的字段别名及字符串 notes。已有双方的无 ID 消息获得临时显示标识，该标识不用于猜测片段引用。无法确定分支归属的可读交互另列，注明不代表依次执行；未知调用端点、变量归属仍保留诊断，不补造关系。兼容显示维持 partial，原记录不改写。
- 回归覆盖五条无 ID 消息、别名冲突、部分片段引用与无 ID 分支、七条主/子流程投影、页面交互和 SVG/HTML 导出。Companion 定向 55 项及 Agent 规则/冻结输入 4 项通过；前端产物重建、worker 入口同步检查和 Desktop 三图安装烟测通过。
- Linux Chromium 截图检查尝试失败：`qa/chromium --headless --no-sandbox --disable-gpu --screenshot=...` 遇到 `EGL_NOT_INITIALIZED` / `Internal Vulkan error (-3)`，未取得截图。未完成 Windows Electron 实机或真实 NGA/CodeAgent 的生成质量验收。

发布须先推送两个组件提交，再更新 Desktop 的组件锁定提交；仅更新 Desktop 本体不会替换冻结旧 Run 的生成规则。现存数据若关系已明确，仅字段格式不同，可改善显示；确实缺失的源码分析事实仍需原 worker 或新分析提供。
