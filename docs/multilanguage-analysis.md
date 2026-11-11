# Python、C/C++、sh/Bash 联合分析

同一 source-first Run 可以选择包含 C/C++、Lua、Python 与 sh/Bash 的源码范围。Planning 按业务功能划分单元；单元可拥有多语言文件，跨单元关系通过已有 context 引用表达，当前新任务使用 Planning → Analysis → 报告流程，speed/depth 均不派发审核或定向修正；历史审核 schema 保持兼容。

## 实现边界

- 识别 `.c/.h/.cc/.cpp/.cxx/.hpp/.hh`、`.lua`、`.py/.pyw`、`.sh/.bash`，并识别无扩展名脚本的 Python、sh、Bash shebang（含常见 `env -S` 形式）。明确声明其他解释器的脚本不按 sh/Bash 接收。
- Python 使用标准库 AST；sh/Bash 使用 `tree-sitter-bash`。只解析源码，不 import 或执行被分析脚本。结构解析失败保留原文、失败位置与降级信息。
- `analysis_language` 保留单语言值，混合范围使用 `mixed`；新增 `analysis_languages`、manifest 的 `file_languages` 和源码索引的 `language`。旧任务不要求这些新增字段，旧 Run 沿用冻结规则。
- 文件收集、按需结构索引、Coverage 匹配、风险线索、场景规则和报告按文件语言处理。C/Lua 专用风险线索不用于 Python/Shell；脚本由对应规则指导 Agent 阅读源码。
- 多语言规则要求核对调用两端的源码证据，以及 argv、解释器、cwd、env、退出码、标准流、文件协议、超时/信号和清理恢复。动态目标、FFI/构建映射缺失时保留待确认；不由 Python 推断调用关系或判定分析质量。
- 真实模型回归后补强了最终命令、连续状态、调用中间层与入口层级审核。内部 Python 脚本/C 后端可执行，不自动代表正常产品入口；绕过启动器的诊断按真实辅助边界保存，不计作产品黑盒。层级与质量仍由 Agent/Reviewer 根据证据判断，不新增关键词或数量门禁。
- 增量变更重新识别实际冻结文件的语言；定向补充沿用父 Run 冻结源码，不修改父 Run。

Shell 首期为 POSIX sh/Bash；Bash 语法解析成功不代表符合 POSIX sh，也不代表脚本执行成功。PowerShell、zsh、fish 未作为支持语言声明。

## Desktop 接入

插件已通过后端 scope preview 与 capabilities 发现语言，无需新增语言选择控件。Desktop 的 `build/pangea-runtime-requirements.txt` 独立于引擎 `pyproject.toml`，需要同时包含 `tree-sitter-bash` 和 `tree-sitter-lua`。

引擎改动位于独立 pangea-agent 仓库。Desktop 的组件锁以 `pangea.components.json` 为准：引擎 `4f495a8cc4f01a51cc71a3963a17ae8e4601671c`，插件 `e8eb7e5833b979c99be922f3892524630e498776`，包含联合多语言分析与仓内拓展调查。新任务的起始目录仍限定规划主责，可通过绑定工具追查所选仓库内的相关代码，并按需保存补充证据；不进入未选仓库，不扩大全仓分析义务，不启用审核。运行时依赖均使用 `==` 精确版本，其中 `tree-sitter-bash==0.25.1`、`tree-sitter-lua==0.5.0`。

## 验证

- `scripts/verify-multilanguage-analysis.py`：使用目标引擎 Python 通过 pytest 执行；覆盖检测、解析降级、冻结快照、源码访问边界、单语言兼容、四场景、speed/depth 两种模式的无审核流程、增量、schema 一致性和报告。新建任务选择真实存在的非根子目录；样例放在 `src/`，单语言任务也选择目录，另测根目录、单文件、缺失目录、越界路径和空范围被拒绝。
- `scripts/verify-multilanguage-plugin.mjs`：设置 `PANGEA_COMPANION_ROOT`、`PANGEA_PYTHON` 后使用 Node test runner 执行；通过真实 Companion API/Python CLI 验证范围预览、确认和单 Run 创建。
- Graph 测试使用显式合成 Worker 记录，验证协议和数据链路，不作为真实模型跨语言缺陷发现率的证据。Windows wheel 可下载、Python wheel 可构建也不等于 Windows 成品验收。

## 真实模型验收工具

`scripts/verify-multilanguage-real-model.mjs` 使用独立工作目录，经 Companion、真实 Python CLI 和 OpenCode ACP 运行完整 source-first 流程。必须传入 `--workspace`（尚不存在的目录）、`--runtime`、`--companion` 和 `--python`；`--fixture-root` 可选择另一份样例，`--mode speed` 选择速度模式；当前引擎新任务不派发审核。本轮未运行该工具，其端到端兼容性未验证。模型默认使用 MiniMax-M2.7，凭据读取已有本地认证或 `MINIMAX_AB_API_KEY`，不写入报告。该工具不提交或推送代码，不修改已有用户 Run。

默认样例 `scripts/fixtures/multilanguage-quota` 是刻意包含缺陷的 Shell→Python→C 小项目，用于核对参数字面值、退出码传播、数值解析和状态恢复。它不是可部署应用。独立判据通过 `scripts/verify-multilanguage-oracle.py --source <源码目录> --output <新证据目录> --python <Python 3.10+>` 执行；判据不放进模型输入。原始样例的契约检查失败是预设缺陷的执行证据，不能直接解释为分析器回归失败。

`scripts/fixtures/multilanguage-quota-corrected` 保留相同业务契约，仅修正 Shell 引号/退出状态及 C 严格数字校验，可通过 `--fixture-root` 独立运行，用于验证误报与回归。扩展判据包含模型实际发现的 `AMOUNT=1_000`：C 前缀解析得到 1，Python 解析得到 1000，原始版本因此污染账本；修正版应整体拒绝，并允许下一次合法请求成功。

验证修正版时给 oracle 增加 `--require-pass`：任一公开入口、后端或恢复序列违背契约即非零退出。原始缺陷样例使用此选项应失败；不使用时只导出观测结果，退出码不能替代 `oracle.json` 中的契约判定。

`scripts/audit-multilanguage-records.py --run-root <精确 Run 目录> --output <审阅目录>` 只读导出实际模型记录。最终验收须另外核对生成用例的前置条件、连续步骤、预期结果和调用两端证据；流程完成、记录数量或图可渲染均不等于语义正确。探针使用的替身后端、解释器版本和路径适配须单独记录。
