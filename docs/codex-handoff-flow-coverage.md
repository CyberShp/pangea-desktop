# Codex 接手：业务流程、覆盖率分析与 Archify

状态：首轮实现已提交。不是已经完成 Windows 产品验收的发布包。
2026-09-09 接管进展：已构建 Windows 本地测试包，完成真实 OpenCode 覆盖分析与画图、取消及导出验收，修复 SVG XML 和外部图完成误唤醒问题。具体提交、证据与未完成的发布门禁见 [Windows 验收记录](windows-flow-coverage-validation.md)。下文“首轮”结果及待办保留为原始交接上下文。
同日排版修订：业务流程页已增加主干聚焦、分支分页及独立图表视图，支持按当前页绘制局部分支图。当前 Dev 实例、组件提交与验证见 [多分支排版验收](flow-reader-layout-validation.md)。
用户已授权执行开发并推送 GitHub，后续由 Codex 接手。本轮不合并主干、不发布成品、不触发 Windows Actions 构建。

## 分支与组件

三个仓库统一使用 `feat/flow-views-coverage`，均基于 `feat/module-analysis-five-stages`；不要从 semantic 拉取实现，也不要丢掉 five-stages 已有的减负、资产交互及 Agent 模型选择。

| 仓库 | 首轮实现提交 |
| --- | --- |
| pangea-agent | 2572ed0fac483374e9e6f1a77e2a2f8f0e4615d5 |
| dsh-pangea | e7a4708563d4059d00adee7b64fb60e8e403a1ff |
| pangea-desktop | 本交接文档所在分支；组件锁定见 pangea.components.json |

最终集成方向仍为 codetalks-skill；five-stages 与本分支验证后按顺序集成。Semantic/LangGraph 不在本次范围。

## 已实现

- 原 Skill 增量约定 mainline_steps/branches，业务流程成为独立导航，原“流程”改“运行过程”。阅读器展示主干与挂接分支、来源证据、风险及用例联动，支持异常/超时/重试/恢复/并发/待确认/未关联用例/显式关联高风险筛选；旧投影保留旧内容。
- 新包 codetalks-coverage-skill 1.0.0，从 codetalks-skill 1.4.0 复制适配为五阶段：输入定位、缺口整理、定向补测、复核修订、交付。保留 CC-BY-SA 来源，移除复制包里无关九步工作流与模板；不改原模块分析为覆盖率工作流。
- coverage-analysis 请求贯通 Python、任务持久化、宿主启动和新建表单。查询 Skill 本地可用性探测只检查入口，不访问内网。
- query 输入冻结 Skill 后调用 combined；file 支持 combined JSON、指定列 CSV/XLSX。源码范围为空时不复制全仓库，通过显式当前 Run prepare-source 冻结和追加必要文件，已复制文件不覆盖。
- 原始 JSON 留在 inputs/coverage/combined.json，CLI 分页按来源/文件/类型提供缺口。成功/partial/no_data 输入复用，失败可重试，分支未知 count 不当缺口，不跨来源合算。
- 覆盖缺口页按来源、类型、文件搜索、分析状态、补测处置筛选；显示独立的实测状态、分析与补测状态。输入汇总按 source×指标呈现，不算范围覆盖比例。
- Archify 固定 10722002bb8777ecb639d93c49586fae4adf3ae4（2.17.0-dev.1，明确是固定开发版），MIT 原始代码位于 vendor/archify。CLI、Skill、schema、示例和渲染资源随包离线供应，禁用更新检查，不使用社区 DSH 插件。
- 按需创建 architecture 会话，继承任务模型或外部 ACP 模型，不创建第二个分析 Run。图任务、停止、状态与产物绑定独立；验证失败保留之前的成功图。限定产物路由和 sandbox iframe，HTML/SVG 可导出。
- Desktop 提供覆盖文件选择器、安装目录 local-skills 定位和开发路径覆盖。升级脚本复制本地 Skill 到候选目录，原目录保留用于回滚；不改变签名 ZIP 校验。

## 内部 Skill 放置与输入契约

用户放置完整 Skill：

- `<PANGEA 解压目录>/local-skills/coverage-query/SKILL.md`
- `<PANGEA 解压目录>/local-skills/coverage-query/scripts/coverage_query.py`

开发时设置 PANGEA_LOCAL_SKILLS_ROOT 指向 local-skills 根目录。三个仓库均忽略该目录，禁止提交内部脚本、地址、真实覆盖报告或认证信息。
创建 Run 后 Skill 副本位于 inputs/coverage-query-skill，用户无需分别给四种 Agent 安装。
公开构建可没有内部 Skill；此时查询方式不可启动，文件方式可用。

请求 coverage_input 为 `{kind:"query",query:{product,c_version,module,b_version?}}` 或 `{kind:"file",path:"完整路径"}`。
版本保留原字符串与空格。代码范围可空，仓库必须已关联。
CSV/XLSX 的列为 source,file_path,kind,count,function,line,block,branch。count 是非负命中整数或 '-'，不是百分比；function/line/branch 分别要求其标识列。当前不猜测其他供应商表头。
inputs/coverage/input.json 是冻结输入描述；文件副本为 report.json/csv/xlsx，避免与描述文件重名。

CLI 新入口（每次带明确 data-root/run-id）：

```powershell
python -m pangea_agent.cli.main runs coverage-prepare --data-root '<数据根>' --run-id '<当前Run>'
python -m pangea_agent.cli.main runs coverage-page --data-root '<数据根>' --run-id '<当前Run>' --cursor 0 --limit 50
python -m pangea_agent.cli.main runs prepare-source --data-root '<数据根>' --run-id '<当前Run>' --scope 'src/module.c'
```

分页支持 --source/--file-path/--kind。需要新成功报告时创建新 Run，不覆盖已冻结报告。

## 已执行验证

| 验证 | 结果及边界 |
| --- | --- |
| Python scripts/verify_coverage_analysis.py | 4/4：来源/文件身份、未知分支计数、分页、BOM、表格数字口径、空范围及追加冻结、查询复用、版本字面保真；均合成数据 |
| Coverage Skill quick_validate | 通过；仅入口格式检查 |
| 独立 Agent 实际使用覆盖 Skill | speed 五阶段及 finalize 完成，delivery_integrity=complete，4/4 用例完整；semantic_verdict=UNRESOLVED、independent=false 如实记录 |
| 合成源码补测 | 实际 GCC/gcov 四主例与四后续请求通过；新增本地来源分支4/4，原报告 gap 仍为 uncovered，不混算来源 |
| Companion npm test | 155/155，包含独立导航/用例与证据联动、覆盖请求保真、外部画图模型继承、图产物身份边界、失败保留旧图；lib/client.js 已生成 |
| Desktop 定向 Vitest | 4 文件12项通过：产品路径、工作区、签名完整包/补丁契约；使用 --maxWorkers=1 --no-file-parallelism |
| Desktop typecheck / build | 均退出0；Electron主进程和preload构建通过，不等于打包或图形窗口验收 |
| Archify 真正离线调用 | vendored CLI 与 PANGEA 包装入口都运行成功；中文标题示例9/9 showcase、0 errors/warnings，生成HTML/SVG |

独立 Skill 试跑仅使用人工构造源码和报告，未接触内网。保留未决的报告/源码版本关联、原 BRDA 方向和真实服务接线；READY 是既有机械交付状态，不能改称语义 PASS。

## 接手后的优先验证

1. 在 Windows 测试环境执行 scripts/verify-local-skills-update.ps1。它只提取迁移 helper，在临时目录验证完整包/补丁复制及回滚，不操作真实安装。当前 Linux 环境没有 PowerShell，尚未运行此脚本。
2. 用组件固定提交构建 Windows 测试包，验证包含两个分析 Skill、Archify 与 Node，并验证内嵌 Python 上运行 combined 和读取 BOM 文件。当前尚未生成新版 Windows 成品。
3. 在真实 DSH 宿主分别跑内置 API 和可用外部 ACP 的覆盖分析与画图，验证模型继承、取消、后台任务完成事件、实际 iframe 中文显示和 HTML/SVG 导出。本轮外部会话执行验证是宿主 mock，不能称四种真实 Agent 都已联调。
4. 用户在内网放入已验收的查询 Skill，按真实产品/版本/模块只读查询并复查记录归属、partial/no_data/error 呈现、暂停恢复和较大输入分页。公开环境无法替代这项内网验收，也不需要用户重新提供敏感材料。
5. 在独立安装目录演练官方签名升级/回滚，确认 private local-skills 保留。用户添加 Skill 后重新压缩的包仅用于首次解压分发，不能作为签名升级 ZIP 导入。

## 当前交互选择与后续增强

- 图产物通过“刷新架构视图”按需读取；没有常驻预览服务器或自动重画。
- 从已有图修改时创建明确关联的新画图会话/新目录并复制 candidate，未声称恢复外部 ACP 原远端会话；原会话可打开继续讨论。
- 没有实现 Archify 节点到 PANGEA 的事件桥。第一版通过旁侧流程/证据阅读器联动，节点事件桥仍是后续增强。
- 源码追加采用逐文件保留，不宣称跨多次追加得到同一提交快照；源码报告版本关系仍由 Agent 核对。
- 覆盖表格未返回完整分母时不算覆盖百分比；不支持旧扁平无文件/来源的分支数据自动关联。

详细范围与原始设计见 flow-views-coverage-development-plan.md。接手时先读取各仓库 AGENTS.md 和本文件，再检查分支状态；不要重跑原九步全模块分析，也不要把尚未真实验收项写成完成。
