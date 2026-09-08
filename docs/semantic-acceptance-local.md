# Codetalks 语义修复：本地实现与验收记录

结论：本地实现已提交，真实 MiniMax 九步验收未运行，不满足推送条件。三个仓库均使用 `fix/codetalks-target-mode-semantic-acceptance`，不合入父分支、不触发 Actions。

## 基线与实现

| 仓库 | 已 fetch 并核对的父提交 | 本地实现 |
| --- | --- | --- |
| pangea-agent | c41e3d109e5493e566ea560659391df86af50f90 | 08bdd37976b314d8e1baf226cc7f8b496bdb3bed |
| dsh-pangea | 6e698fd994fb7ca092b4a528372916d1b90cd433 | 909bafa90cc3cb93d01514c0d0222da53c909705 |
| pangea-desktop | c3a88e7a5de768b5077802c6a3d10772a0677d8a | 本文所在提交 |

产品实际只支持 `mode=depth/speed`，没有“目标模式”枚举。本轮按用户要求的独立 Reviewer 准备 `depth`；若“目标模式”另有所指，仍需确认映射。depth 的启动请求要求宿主派发独立 Judge，但现有门禁仅消费 Agent 的 `independent` 声明，不能证明真实执行。界面因此明确标注“Agent 声明，宿主未核验”，不会由 READY 推导独立审查或语义 PASS。

本地旧 checkout 并非交接所称的干净工作区；两处有未提交改动，均保留。新 worktree 直接从远端父提交创建。

改动：

- Step 05/06 复用候选池记录完整契约、支持范围、源码传播、最小反事实和根因归并；将范围限制、覆盖缺口、驳回及合并候选与正式风险分开。Step 08 主动反证，复用审查报告、`review_issues` 和审查状态，不新增语义判定脚本。
- Step 02 保留完整契约；新 Run 的 requirement/design 允许步骤增加 08，供 Judge 回查冻结原文。coverage 仍是 03/05/07；已有冻结清单不修改。
- complete-step 09 / finalize 对比投影 ID 和正式 Markdown 的五个详细字段，返回 `delivery_integrity`、`repair_required` 和原文件路径。缺项保留为降级交付，由当前 Agent 修正同一文件再 finalize；不生成步骤、不否决风险、不创建第二套生命周期。只有可读性、身份和既有结构检查仍走原错误路径。
- 速度型允许如实记录 `independent=false`；深度型继续要求独立审查。语义结论读取 Reviewer 声明的 PASS/UNRESOLVED；缺失时显示未给出结论。
- Companion 按正式文档重新计算交付完整性，正式导出不再用草稿或投影字段填补正式文档缺项。流程、交付、审查方式、语义结论分开展示；生成客户端已同步。
- Companion 的任务账本改用每次写入唯一的临时文件；Windows `EPERM`、`EBUSY`、`EACCES` 仅做 50/100/200/400/800ms 有界重试，失败时保留原 JSON、清理自己的临时文件，并避免首次持久化失败留下幽灵任务。
- 新 Run 的源码冻结改为单遍复制，只记录相对路径、大小、文件数、总字节和复制耗时；不再计算源码 SHA、清单 digest 或复制后的二次读取校验。源码仍只从 Run 副本读取。
- Codetalks Skill 顶层入口精简为 235 行路由与全局约束，三个核心规则 ACK 合并为一次 `ack-core --all`，各步骤细节按需读取现有 step/reference 文件。
- 内置 API 分析会话恢复 DSH 原生消息流，消息、工具调用和 todos 不再被 ACP 过程面板遮蔽；分析会话输入框保持只读，外部 ACP 仍使用原过程面板。
- 启动日志时间固定为 UTC+8 ISO 时间，界面按 `Asia/Shanghai` 展示；每个启动阶段记录耗时，Run 创建事件额外记录源码复制文件数、字节数和复制耗时。
- Desktop 已吸收父分支 c3a88e7 的构建修复，组件锁由旧的 6e698fd/c41e3d1 改为上述子分支两个提交。验收构建从同名子分支解析这些提交；正式合入后必须把组件分支锁一并改回 `codetalks-skill`。

## 本地证据

| 检查 | 结果与边界 |
| --- | --- |
| Agent unittest | 14 通过；新增源码单遍复制、UTF-8 文件名/内容和一次性核心规则 ACK 回归 |
| Companion npm test | 134 通过；包含内置/ACP 显示分流、UTC+8 日志、阶段耗时、源码复制指标和 Windows 任务持久化回归 |
| PANGEA 产品壳 npm test | 23 通过；覆盖内置会话保留原生消息流且输入只读、ACP 继续使用过程面板 |
| Asset Catalog npm test | 14 通过、1 跳过 |
| Desktop 相关 Vitest | 6 文件，28 通过、1 条需显式 runtime 配置的测试跳过 |
| Desktop 全量 Vitest | 当前父分支与本地组件锁下 420 通过、13 失败、3 跳过，不能报告全绿 |
| Typecheck / Electron Vite build | 通过；不等价于 Windows 成品或真实 UI 验收 |
| Python/JS Markdown 消费一致性 | 4 种格式的字段结果一致：加粗、编号/章节、表格、无 TC 前缀的精确投影 ID |
| CSV/XLSX 本地序列化 | 合成 26 条详细用例，所有单元格一致，冻结行定位 A13；不是 Desktop 实际下载验收 |
| 项目 Skill 校验 | validate_runtime_skill/digest 测试通过；通用 skill-creator 校验器不支持项目已有 version/derived_from frontmatter |

Desktop 全量失败包括：LAN bridge/tunnel 的 9 项 `uv_interface_addresses` 权限错误；branding、directory-picker、Feishu workflow、market-installer 四项现有断言不一致；ACP probe 的 500 ms 超时测试在并行全量运行中未进入 ping（相关测试单独运行通过）。这些 Desktop 产品代码和旧测试本轮未改动。没有放宽断言或修改系统权限来获得通过结果。

## 消息队列和资产准备

上一轮 Windows 原始 Run 和源码不在当前环境。`scripts/fixtures/semantic-queue` 是按交接描述重新构建的 50 行 C / 16 行头文件小夹具，不冒充旧 Run 证据。

`verify-semantic-queue.py` 在临时目录编译独立 C oracle：容量 1–8、每种 30 轮，原实现 480 次边界检查失败；仅替换 `offset > q->count` 为 `offset >= q->count` 后失败数为 0。clear 未改动，出入队、INT_MIN/INT_MAX、清空后 pop 和 FIFO 断言均通过；夹具文件哈希前后相同。覆盖 XLSX 没有参与 oracle。

`prepare-semantic-acceptance.py` 使用真实资产导入与 Run 创建 API，创建隔离数据目录，冻结设计与 XLSX、只拷贝 mq.c/mq.h 作为分析源码。oracle 和预期答案不进入源码范围。XLSX 含 6 条可解析函数记录、7 列和明确的合成数据标识；原始 XLSX 留在冻结资产中。测试发现初版表头不符合产品导入合同后调整了夹具，没有放宽解析器。

最终准备目录：`/workspace/scratch/58aa22e8818d/semantic-acceptance-committed/`，Run ID `semantic-queue-depth`，两个资产均 revision 1，源码已复制到 Run。`model_run_started=false`，九步未执行，不伪造模型请求或审查记录。

## 未完成的完整验收

当前环境为 Linux，没有上一轮 `dist-dev/win-unpacked`、可访问的 Windows 宿主或 MiniMax 配置。`npm run package:dev:dir` 实际停止在 staging 检查，缺少 Windows Python/runtime、插件组装 manifest 和 update 元数据；也未发现 PowerShell 可执行入口。本次没有形成可启动的 Windows Dev 成品。

以下必须在真实 Desktop Dev + MiniMax 环境继续，均未宣称通过：

- 从实际请求记录确认 MiniMax-M2.7-highspeed，而非根据 UI 或历史配置推断。
- 资产管理选中并冻结两个资产；模型在允许步骤实际读取全部必要材料。
- 真实独立 Judge 的宿主会话/任务证据，Step 01–09 + finalize，无人工语义纠偏。
- 正式风险只保留 peek 边界根因；clear 不独立计数，并发只列范围限制，容量 1/回绕列补测，无 int NULL 风险。
- 实际生成的所有投影用例都有完整正式详情，页面 CSV/XLSX 下载一致。
- 真实界面四种状态的可读性与交互通过。

只在这些验收与必要工程测试均通过后推送三个子分支。当前保留本地提交、日志和准备目录，未推送、未合并、未触发构建。

复现准备命令（输出目录必须不存在）：

```powershell
python scripts/verify-semantic-queue.py --cc gcc
python scripts/prepare-semantic-acceptance.py --agent-root <本轮pangea-agent工作区> --output <新验收目录>
```

Windows Dev 组装使用现有脚本的 `-DshPangeaSource`、`-PangeaAgentSource` 指向本轮本地提交，并使用 `-SkipPackage` 先完成隔离 staging，再运行 `npm run package:dev:dir`。这是接续所需的未完成工程任务，不是要求用户替代 Agent 完成开发验收。
