# 资产管理 Windows 验收

日期：2026-09-08。验收对象为独立 PANGEA Desktop Dev 的资产管理主链路。

## 测试范围与数据

使用合成仓库 `asset-acceptance-minimal`，分析范围严格为 `src/clamp.c`：8 行、一个 clamp 函数。仓库另有 `unselected.c` 用于验证范围隔离；它未进入 Run 源码快照。

资产集包含需求、设计、历史缺陷、参考资料、Coverage XLSX、用例示例，另加空白文档、损坏 XLSX 和 15 份分页资料。界面实例共有 23 个资产。所有数据均属于本轮独立验收环境。

真实 OpenCode 1.18.28 通过 Desktop 启动，使用其 ACP 默认模型 `opencode/big-pickle`，速度模式。Run 为 `src-clamp-c-clamp-260908-01`，任务为 `task-20260907162125-8532bf`。

## 发现并修复

| 问题 | 复现与原因 | 修复 |
| --- | --- | --- |
| 新导入历史缺陷无法审核 | 文本规范化后进入 awaiting_review，但整份审核接口强制要求旧结构化结果路径 | 支持人工批准/拒绝规范化历史缺陷文本；旧逐条审核保留；新修订重新进入待审核 |
| 损坏 Coverage 不进入失败列表 | XLSX 解析异常未持久化状态，资产停在 imported | 写入 failed 与 last_error，保留失败资产 |
| Windows 中文标题和错误乱码 | 资产插件按 UTF-8 解码 Python 输出，Python 却使用本地编码 | 与 Companion 一致，显式设置子进程 PYTHONUTF8 和 PYTHONIOENCODING |
| 已选资产显示不完整 | 表单以当前仓库筛选结果渲染已选列表，六项实际提交只显示两项；加载前显示“未选择” | 始终按已选 ID 渲染，未加载标题时显示 ID，并允许逐项移除 |
| 第三版修订报 WinError 32 | 第二版文件已在历史修订目录，再修订时 copy2 的源与目标相同 | 同路径时保留已存在的历史文件，继续创建新版本 |
| 无法下载失败记录 | Python 已返回 failure_record，资产 HTTP 详情接口未传递该字段 | 补回原有字段，使界面能显示错误及下载按钮 |

每个修复均有对应失败测试或真实接口复现；不新增依赖、模型配置或 Graph 生命周期。

## 验收结果

| 场景 | 结果与证据 |
| --- | --- |
| 文件选择、预览、确认导入 | 浏览器实际选择 requirement.md，显示大小、SHA256、Semantic 归类，导入后可用 |
| 六类资产、空文档、损坏文件 | 真实 HTTP → Node → 包内 Python 链路通过；空文档 no_items，损坏文件 failed |
| 重复内容、预览后内容变化 | 明确拒绝，中文错误可读 |
| 同名新修订 | 保留 ID，修订号和指纹更新；连续至第三版成功，旧源文件保留 |
| 标题、仓库、模块、语言 | 界面编辑保存，中文标题无乱码；服务端仓库/模块过滤通过 |
| 审核与归档 | 界面批准新历史缺陷后可选择；拒绝、未审核不可冻结、新修订失效审批由回归测试覆盖；废弃后不在可用筛选，恢复后状态恢复 |
| Coverage | 解析出 clamp 的 3 次覆盖记录，允许步骤为 03/05/07；用例示例仅 07，历史缺陷仅 05 |
| 分页与筛选 | 23 项按 20+3 分页，无重复/缺失；界面第二页正确显示三项；文本与 Semantic/Evidence 筛选通过 |
| 资产进入实际分析 | 六类资产全部写入 Run manifest，历史缺陷标记 approved；Agent 实际读取输入并完成 Step 01 |
| 表单显示与移除 | 最终开发实例跨筛选选择两项资产，表单加载前完整显示两项 ID；未关联仓库的 Coverage 可直接移除 |
| 失败详情与下载 | 最终实例显示真实错误、指纹与下载按钮；真实 HTTP 回归确认 failure_record 内容。点击下载后内嵌浏览器的下载事件超时，文件落盘未计通过 |
| 冻结隔离 | 资产库设计资料由第 2 版升至第 3 版，Run 的第 2 版文本和 manifest 字节不变；源快照仅有 clamp.c |
| 测试清理 | 正常停止本次 Run；任务显示 stopped，ACP 启动进程已退出；保留数据供复查 |

自动化结果：资产插件 11/11（含真实 Windows Python/HTTP 详情链路），Companion 125/125，Agent 当前全部测试 15/15。插件客户端已生成，修改同步到独立解包实例；原安装目录未修改。

## 证据位置与边界

本地证据目录为 `.pangea-build/asset-acceptance-0908/`：`api-results.json` 保留初次失败；`api-clean-results.json` 为修复后的干净数据集 12/12；`api-recheck-results.json` 为实际目录复验；`freeze-pagination-results.json` 为真实 Run 冻结与分页验证；`stop-result.json` 为停止结果。

测试命令结果保存在 `deliverables/asset-catalog-tests.txt`、`deliverables/companion-asset-tests.txt`、`deliverables/agent-asset-tests.txt`。可从 `dist-dev/win-unpacked/PANGEA Desktop Dev.exe` 打开独立实例，进入“资产管理”。

本轮通过项是资产管理主链路和单文件分析接入。完整九步分析、AI 方法论候选生成、失败记录下载落盘与真实内网 Windows ACP 验收未计为通过；测试 Run 在 Step 01 后主动停止，没有生成正式分析报告。全部修改尚未提交或推送。

后续更新：以上是首轮阶段记录。后续已完成三个小模块的九步流程、文件落盘与方法论组件补验；最终结果及仍未通过项见 [多任务完整验收记录](asset-management-multi-run-2026-09-08.md)。
