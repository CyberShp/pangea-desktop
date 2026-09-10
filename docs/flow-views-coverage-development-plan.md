# PANGEA 业务流程、Archify 与覆盖率分析详细开发方案

状态：首轮功能已实现并完成本地定向验证，待 Windows 成品与真实宿主联调。实施结果、差异与接手事项见 `codex-handoff-flow-coverage.md`。时间口径：UTC+8。

## 1. 开发基线与范围

三个仓库均从远端 `feat/module-analysis-five-stages` 创建本地 `feat/flow-views-coverage`，不修改 `semantic`，最终集成目标为 `codetalks-skill`。

| 仓库 | 本次起点提交 | 已核对的基线能力 |
| --- | --- | --- |
| pangea-agent | 8ae1fb5cb18b2d1a93c83e7fc721777555718ae6 | Codetalks 1.4.0 模块五阶段、Run 冻结 manifest、恢复与阶段发布 |
| dsh-pangea | 83e2e12921ad736b0fc3e986b22168c56c0b7774 | 资产选择交互、外部 Agent 模型发现与新建分析选择 |
| pangea-desktop | 495a48b0b5b7f5afe86809e2e707e7fda5c8b046 | Agent 模型选择产品入口与 Windows 测试包集成 |

本次包括：业务流程阅读器、主干/分支投影、按需 Archify 图、独立覆盖率分析 Skill、内部查询 Skill 本地接入、文件输入和相应工作台。运行环境沿用用户选择的内置 API 或 nga/opencode/codeagent/Claude Code。

原 Codetalks 的模块分析保持五阶段，不恢复 Graph/action/settle，不继续在本分支重构资产管理和模型发现。涉及原 Skill 的更改仅限本次需要的流程投影约定。覆盖率分析从基线 Skill 复制并独立维护。

## 2. 内部覆盖率查询 Skill 的固定放置位置

用户在新解压的 PANGEA 目录中创建：

`<解压目录>/local-skills/coverage-query/`

目录中的直接文件为 `SKILL.md`；执行入口为 `scripts/coverage_query.py`，其余脚本和参考资料按原 Skill 相对结构完整放入，不能再多套一层 Skill 目录。根目录名称固定为 coverage-query，SKILL.md 中原有名称可以保留。

例如安装在 `D:\Tools\PANGEA` 时：

- `D:\Tools\PANGEA\local-skills\coverage-query\SKILL.md`
- `D:\Tools\PANGEA\local-skills\coverage-query\scripts\coverage_query.py`

真实 Skill、地址和内部配置只由用户在内网放入。三个 Git 仓库均忽略 `/local-skills/`，公开构建不含此查询 Skill，也不需要其存在才能构建。开发验证使用临时合成查询脚本，不能提交内部材料。

Desktop 以安装目录定位 local-skills；开发环境允许用明确的 `PANGEA_LOCAL_SKILLS_ROOT` 指定同结构根目录。该路径通过产品环境传给 Python 和宿主，不扫描用户全盘或其他 Agent 的配置来寻找 Skill。

功能可用性只检查入口文件是否存在，不通过真实平台查询作为启动探针，不扫描或展示内部配置。查询方式缺少 Skill 时，新建页显示固定放置位置并提供重新检测；文件输入仍可使用。

创建查询型 Run 时复制这一份 Skill 到 Run 的 `inputs/coverage-query-skill/`，运行请求写入准确位置，Agent 只需读取这一份，不要求分别安装到四个客户端。后续更新本地 Skill 只影响新 Run；续跑使用当前 Run 副本，不做哈希复验。环境凭据不另行收集、复制或保存。

### 2.1 分发与升级

用户将 local-skills 放入全新解压包后，重新压缩用于首次解压分发；不要将已使用目录里的 Run、用户数据和配置一起分发。

当前升级器要求 ZIP 全部载荷与签名清单一致。因此添加内部 Skill 后的分发 ZIP 不能冒充原签名升级包，不能通过放宽签名验证来解决。软件内升级继续使用原始签名完整包或补丁。

当前升级脚本替换整个安装目录，未迁移 local-skills。实施时在替换前将当前安装的 local-skills 复制到候选安装目录，随后再交换目录；只处理这个明确目录。升级失败回滚仍使用原安装目录，不能移动或删除原 Skill。本地内容优先，官方包不供应内部查询 Skill。此项必须有升级/回滚测试，不能仅创建目录即宣称可持久使用。

## 3. 业务流程阅读器

新导航为：概览 / 业务流程 / 风险 / 测试用例 / 运行过程 / 复核。现有 workflow 展示运行阶段，名称改为运行过程；flows 单独归属业务流程，不能再将 flows 的活动导航映射成 workflow。

布局：左侧流程列表、中间主干步骤及挂接分支、右侧当前分支详情。窄窗口依次排列，不强行压缩三列。支持按流程名搜索，以及异常、超时、重试、恢复、并发、待确认、未关联用例等过滤。

顶部统计流程、分支、待确认、未关联用例。只有分支显式关联已分级风险时才能据此显示高风险关联，不由前端猜测风险等级。

每个步骤展示：外部动作、内部处理、状态变化、外部可观察结果。分支展示：进入条件、判断、处理、残留状态、外部表现、回接点或终点，以及关联风险、用例、证据。

### 3.1 工作台投影的增量字段

保留当前五个数组和顶层 schema_version=1.0。新增字段属于显示信息，不新增基于关键词或数量的语义门禁。

business_flows 每项保留 flow_id、现有名称/说明/证据，并扩展：

| 字段 | 内容 |
| --- | --- |
| mainline_steps | 按执行顺序的步骤数组 |
| mainline_steps[].step_id | 流程内稳定步骤编号 |
| mainline_steps[].title | 步骤标题 |
| mainline_steps[].external_action | 外部触发或操作 |
| mainline_steps[].processing | 内部处理摘要 |
| mainline_steps[].state_change | 状态变化 |
| mainline_steps[].external_observation | 外部表现 |
| mainline_steps[].evidence_ids | 已有证据关联 |
| branches | 分支数组 |
| branches[].branch_id | 当前 Run 内稳定分支编号 |
| branches[].from_step_id | 从哪个主干步骤分叉 |
| branches[].kind | Agent 明确的分支类别 |
| branches[].condition / processing / result | 进入条件、处理与结果 |
| branches[].residual_state / external_observation | 残留状态、外部表现 |
| branches[].to_step_id / terminal_result | 回接步骤或结束结果；按实际情况填写 |
| branches[].status | 已分析或待确认等明确状态 |
| branches[].linked_risk_ids / linked_test_case_ids / evidence_ids | 联动引用 |

Agent 在分析每个流程时维护字段并 publish-stage，Python 不从 Markdown 或代码生成语义结构。暂缺字段展示未提供，局部坏引用显示具体提示，不丢弃整个流程，不将其推断成无分支。

旧 Run 没有新数组时显示原流程卡片与文档入口，提示没有结构化主干/分支；不重新运行旧 Skill，也不重写旧投影。

## 4. 独立覆盖率分析 Skill

包名 `codetalks-coverage-skill`，场景 `coverage-analysis`。从本次基线 codetalks-skill 复制，保留来源与许可信息，替换入口、manifest、阶段文件和适用模板；清除复制包中无关的旧九步骤路径与强制交付要求。

| 阶段 | 任务 | 核心产物 |
| --- | --- | --- |
| 01 输入与定位 | 读取文件或调用 combined，读取源码版本描述，定位范围 | 输入与范围、原始覆盖数据、查询摘要 |
| 02 缺口整理 | 按来源/文件建立缺口清单，关联源码，分组与优先级 | 缺口台账、运行计划 |
| 03 定向分析与补测 | 沿缺口追溯入口及触发条件，分析后续结果，生成补测 | 缺口分析、补测用例、阶段投影 |
| 04 复核与修订 | 复核来源、可达性、反证、观测和未决项，定向修订 | 复核记录 |
| 05 交付 | 发布已审内容与限制 | 覆盖缺口分析.md、黑盒测试用例.md、完整分析报告.md |

用例文件沿用黑盒测试用例.md，以复用现有正式用例阅读器。页面标题为补测用例。风险属于可选发现，缺口不等于风险，不能为每个缺口强造风险或 SFMEA。风险数组允许为空。

保留原 Skill 的独立复核真实性、源码反证、黑盒操作/独立 Oracle/清理恢复、compact 游标和增量发布。按缺口业务路径分组分析，共享调用链；不先完整跑一遍模块全量分析。

### 4.1 新建请求

沿用 repository、target、asset_ids、mode、provider/model；scenario 选择 coverage-analysis。增加 coverage_input：

- kind：query 或 file。
- query：product、c_version、module，b_version 可选；版本字符串保留空格及原样语义。
- file：用户选择的文件输入，复制到当前 Run；不接受仅有文件名的虚假消费。
- source_scope：可空；空表示让 Agent 定位，不代表自动全仓库深度分析。

后端、任务持久化、启动器必须共同传递这些字段；旧请求省略 coverage_input 时保持原行为。

范围为空的覆盖率 Run 先创建任务及输入，在第一阶段由 Agent 根据报告路径与关联仓库定位最小范围，再调用明确的当前 Run 源码准备入口复制所选文件。该入口使用显式 data_root/run_id/scope，不推断其他 Run；允许在分析中为同一 Run 补充必要依赖，记录来源，已复制文件不重写。不能在创建时静默将空范围变成整仓库复制，不能要求用户为消除后台限制强制填范围。

报告路径是定位线索，源码匹配由 Agent 核对。记录未匹配、歧义、范围外和版本待确认项；不能删除后假装完整。用户限定范围时，范围外文件仅在解释依赖确有需要时读取，补测范围仍由用户限定。

### 4.2 查询与输入处理

查询契约已由内网验收：`python scripts/coverage_query.py combined --product ... --version ... --module ... [--b-version ...]`。实际运行使用 Desktop Python 与参数数组，禁止拼接未经转义的 shell 命令。Agent 在阶段 01 发起读取后的组合查询；模型不获取秘密配置内容。

stdout 直接保存为 inputs/coverage/combined.json，查询日志与进度使用独立摘要，避免把约 442 KB 或更大的 JSON 整体送入模型上下文。新增确定性辅助命令提供概览、按来源/文件的分页读取；原始输出保留。续跑复用已获取结果，用户明确重新查询时才产生新输入版本。

上传支持 combined JSON 和明确列结构的函数/分支覆盖率表格；首版覆盖 JSON、CSV、XLSX。现有 coverage.py 可复用，但必须明确三态及计数/标记/百分比区别。无法识别的格式给出具体缺失列及模板，不按关键词猜测数字口径。UTF-8 JSON/CSV 读取兼容 BOM。

查询成功并非分析成功。success 继续；partial 对有效来源继续并保留限制；no_data 显示无可用覆盖数据；error 显示实际失败，可重试输入获取。后两种不生成缺口已清零的结论。超时、停止时清理本次查询子进程，不因此删除已完成分析内容。

### 4.3 combined 消费契约

| 字段 | 使用规则 |
| --- | --- |
| status/message/missing/warnings | 查询状态与缺失，不转为源码质量裁决 |
| product/c_version/b_version/module | 保留查询对象 |
| sources[] | 以 source 加指标关联统计；两个来源三种指标是六条组合记录，不是六种来源 |
| uncovered_functions[] | source、file_path、uncovered_functions |
| uncovered_lines[] | source、file_path、uncovered_lines |
| uncovered_branches[] | source、file_path、uncovered_branches，其中含 line/block/branch/count |

不读取旧命令中代表最后一个来源的顶层 rate 作为总覆盖率。不跨来源相加或平均；summary 名称也不能据此推断为所有来源的并集。

每条 gap 带 gap_id、source、file_path、kind、原始函数名或分支标识，以及 Agent 写出的定位/分析/用例关联。函数缺口键含文件与函数；分支键含来源、文件和 line/block/branch，ID 只在本次 Run 内使用，不以哈希校验。

函数已命中不证明内部具体分支已覆盖；模块分支率不足也不能定位到某个已覆盖函数。branch=0/1 不等于 false/true，行号匹配只证明位置关联，具体方向需源码和报告证据；不确定方向明确待确认。缺失记录、count='-'、未插桩未知不当成零命中或已覆盖。

### 4.4 工作台

覆盖率 Run 导航为：概览 / 覆盖缺口 / 补测用例 / 运行过程 / 复核；存在已分析业务路径时可进入相同流程阅读器，不要求全模块图。

原五个投影数组继续兼容，coverage-analysis 额外发布 coverage_gaps 和覆盖输入摘要引用。raw 数据与分析结果分开保存；前端不从函数名推导测试语义。

缺口列表按来源、文件、类型、分析状态、处置筛选。详情显示原始覆盖事实、源码位置、触发路径、保护条件、外部结果、补测用例、证据与未决项。

执行覆盖状态、分析进度、补测处置独立表示。已设计用例不改变未覆盖事实；没有复测输入就不能声称提升覆盖率。筛选后的范围没有完整统计分母时只显示缺口数，不生成范围覆盖百分比。

## 5. Archify 集成

### 5.1 入口与行为

业务流程页顶部“生成模块架构图”，当前流程“生成流程图”。默认一次生成一张，可选 architecture/workflow/sequence/lifecycle/data-flow。首版包含生成、查看、继续修改、重新生成、停止本次画图及导出 HTML/SVG。

新建 architecture 类型独立会话，关联同一任务与明确 Run；默认继承该任务 provider/model/effort。实际模型已不可用时提示选择可用模型，不能静默换另一模型。主分析会话、完成状态和正式结论均不受图任务影响。

向会话传入：选中的 flow_id 或模块范围、已发布投影版本、关联风险/用例/证据、Run 源码位置、Archify Skill/CLI 路径及本图输出目录。只补读与目标图有关的源码。

复用宿主现有 sessions、ACP job 和模型选择能力，但分离“准备分析 Run”与“执行已准备提示”的代码路径。图任务不能调用 create_skill_run、stop_skill_run 或以主 Run 完成状态进行 ACP 续接判断。

后续修改续接原画图会话。外部 ACP 会话可恢复时使用宿主支持的真实恢复机制；无法恢复则明确创建关联的新画图会话，并载入该图 JSON 继续，不冒充续接成功。

### 5.2 产物与显示

每张图放在 `<run_root>/派生视图/archify/<view_id>/`，保存描述 JSON、交互 HTML、渲染收据和 manifest。manifest 记录 view_id、run_id、flow_id/范围、类型、来源投影 revision、会话/任务绑定和 UTC+8 时间。

状态按真实事实显示：未生成、生成中、可查看、失败、已停止；有当前来源变化时标注基于旧分析版本，不后台自动重画。渲染成功与源码语义正确性分开。

Archify CLI 负责图结构与布局校验，具体错误交回同一画图 Agent 修订，保留上一版成功图。新图不能覆盖原投影、风险、用例、主 Run 状态；发现分析疑点通过会话报告。

HTML 通过限定到本图目录的读取路由，在 sandbox iframe 中显示；允许所需脚本而不给 Node/Electron 权限，不开放任意路径加载。导出通过明确产物路由。节点点击联动使用图节点到 PANGEA ID 的显式映射和受限事件桥接，若上游无对应事件机制则作为后续增强，首版保留旁侧证据列表。

### 5.3 离线打包

固定经过验证的 Archify 上游提交，保存许可与来源说明；打包 Skill、CLI、运行资源，复用 Desktop 的 Node 24。设置 ARCHIFY_UPDATE_CHECK_DISABLED=1，不运行 npx 在线安装，不采用依赖特定 DSH 预览版的社区插件。

首版使用一次生成的独立 HTML，不启动常驻预览服务。Windows 打包时验证真实 CLI 能离线生成中文示例图、渲染及导出，不以文件存在代替验证。版本选择属于实施事项，本方案不将变化中的 upstream main 写成已验证版本。

## 6. 实施位置和顺序

| 顺序 | 仓库及位置 | 工作 |
| --- | --- | --- |
| 1 | pangea-agent / skill_packages/codetalks-skill | 新流程字段约定、阶段输出指导及模板 |
| 2 | dsh-pangea / companion reader、client | 业务流程独立导航、主干/分支阅读和联动 |
| 3 | pangea-agent / skills.py、skill_runs.py、cli、documents | 多 Skill 选择、覆盖率请求、延迟源码准备和输入分页 |
| 4 | pangea-agent / skill_packages/codetalks-coverage-skill | 独立五阶段覆盖率分析 |
| 5 | dsh-pangea / task-store、pangea-api、workbench-api、client | 保存覆盖参数、启动与缺口展示，生成 lib/client.js |
| 6 | pangea-desktop / pangea-product、环境及升级脚本 | 本地 Skill 固定路径、打包资源、升级保留 |
| 7 | dsh-pangea / 派生视图服务与宿主启动 | 图任务绑定、独立会话、渲染展示与停止 |
| 8 | pangea-desktop / components、构建脚本 | 固定 Archify 资源，锁定本次 agent/plugin 提交并验证成品 |

不新增 Python 模型 API、不用机械层猜测分支/风险，不通过宽松默认值掩盖输入缺失。本次字段是显示及输入关联契约；除真实路径边界和不可读取输入外，不新增裁决语义质量的硬门禁。

## 7. 验收

1. 新投影展示正常主干、异常/超时/恢复分支，点击关联到准确的风险/用例/证据；缺字段不猜测，旧 Run 可读。
2. coverage query 与文件输入均可启动；函数数据不伪装成分支数据；空代码范围不强制全仓库复制。
3. 合成数据覆盖不同文件同名函数、同行号分支、不同来源不同命中状态、未知计数、无数据、partial、BOM；已设计用例不改变实测状态。
4. 较大 combined 分批读取，compact 或暂停后恢复当前缺口，不重复查询或重写全部报告。
5. 内置 API 与可用外部 Agent 走相同请求和产物约定，继承用户所选模型，不受内部 Skill 在客户端全局是否安装影响。
6. 图任务对主 Run 无写入；真实渲染离线成功、嵌入可用、失败保留旧图、取消只停止本图；不把示例静态 HTML 冒充 Agent 生成链路已验证。
7. 新解压包放入 local-skills 后可识别，软件升级及回滚保留内部目录；原签名验证不放宽。
8. 运行受影响的 Python 测试、插件测试与客户端生成、Desktop typecheck/build；无 Windows 环境或真实内网数据时明确未实测项，不交给用户代做可由 Agent 完成的工程检查。

本地提交按可审查功能拆分。推送、合入与 GitHub 构建需遵循该操作在当前会话中的授权；不以文档提交冒充产品功能完成。
