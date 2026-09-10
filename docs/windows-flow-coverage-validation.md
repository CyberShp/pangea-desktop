# Windows Flow 分支接管验收记录

日期：2026-09-09（Asia/Taipei）。范围：交接文档中的 Windows 本地迁移、固定组件测试包、真实外部 ACP 覆盖分析与独立画图。当前结论是本地测试包可供手动验收；正式发布门禁仍未全部满足。

## 代码与实例

三个源码 worktree 均为 `feat/flow-views-coverage`，位于 `D:\pangea-source` 下各自的 `*-flow-views-coverage` 目录。原安装目录 `D:\pangea-desktop` 未修改。

最终测试包组件：

| 组件 | 提交 |
| --- | --- |
| Desktop | `0b69d89a206fc9b1fe7e1503c357934781fe6f7d` |
| dsh-pangea | `f316dc969a045eb0893df575e445278cd23ee794` |
| pangea-agent | `2572ed0fac483374e9e6f1a77e2a2f8f0e4615d5` |

本文及交接文档更新是上述测试包之后的纯文档提交。组件身份以包内 `resources/pangea-manifest.json` 为准。

以下路径均相对 Desktop worktree：

- 最终未签名测试包：`.pangea-build/verified-package-v2/win-unpacked`。
- 已启动的验收实例：`dist-dev/win-unpacked`；其 EXE、组件清单及两处修复文件已与最终包进行 SHA256 比对。
- 隔离 profile：`.pangea-build/flow-host-profile`。合成 Run 在该实例的 `launch-root/pangea-data`，没有使用用户原 profile。
- 当前浏览器入口：`http://127.0.0.1:6955`。重启后端口以 profile 的 `logs/harness.log` 为准。
- 重新启动同一验收实例：执行本地 `.pangea-build/start-flow-validation.ps1`，保留相同 profile 和合成数据。

## 实测发现与修复

1. Windows 路径测试把 POSIX 字面路径当作平台输出。Desktop 测试使用 `path.join` 构造预期值，并补充内嵌 Node 路径断言；生产路径实现无需修改。
2. Archify 导出的 SVG 内联字体 CSS 含未转义的 `&`，HTML 能显示而 SVG 不是合法 XML。`architecture-render.mjs` 对写入 SVG 的样式文本执行 XML 转义，保留原 HTML。新增回归测试，并使用真实渲染结果经过 XML 解析验证。插件提交 `0a5d0e1`。
3. 外部画图任务成功后，通用 Jobs 通知会唤醒没有内置 API 模型的宿主会话，导致 `has no provider/model`。独立画图启动时注册实际 Jobs 等待者来消费完成通知，仍向其他完成观察者发送事件。真实 Cordis/Jobs 回归先复现一次错误唤醒，再验证为零；完成和取消时等待者会释放。插件提交 `f316dc9`。

故障记录分别位于插件仓库的 `docs/bug-report/archify-svg-xml/bug-report.md` 和 `docs/bug-report/architecture-job-wakeup/bug-report.md`。

## 自动验证

| 项目 | 本次结果与证据 |
| --- | --- |
| local-skills Windows 迁移 helper | 完整包、补丁候选复制及回滚通过；仅临时目录，不等于正式签名升级验收 |
| Python 源码快照与五阶段模块机械验证 | 7/7 与 7/7；`flow-assembly-verified.log` |
| 插件 core / companion | 23/23 与 156/156；完成通知修复后 companion 全量再次通过 |
| 资产插件 | 17 通过、1 条 Python 相关测试在默认环境跳过；指定包内 Python 后单独运行对应文件 4/4，通过 UTF-8 路径验证 |
| Desktop | typecheck 退出 0；14 文件 95/95；`flow-assembly-verified.log` |
| Windows 构建 | Electron 构建及最终 electron-builder `--dir --win --x64 --publish never` 退出 0；`flow-package-final.log` |
| 最终包内 Python | 覆盖回归 4/4、BOM JSON、XLSX 未知计数、两个分析 Skill 均通过；确认导入来自包内 |
| 最终包内 Node / Archify | 真实离线中文 HTML 与合法 SVG；失败修改保留成功图且主 Run 状态和投影不变；`flow-runtime-final.log` |
| 最终包内真实 Cordis / Jobs | 2/2，完成观察者收到事件且不唤醒未配置模型的图会话；`flow-cordis-final.log` |
| Windows ACP 批处理契约 | NGA、CodeAgent、OpenCode 三种 batch shim 启动及同会话续跑通过，取消为 aborted；`flow-acp-batch.log`。这些是协议夹具，不是三种真实模型联调 |

新增可重复的包内验证入口：

```powershell
node scripts/verify-flow-runtime.mjs '.pangea-build/verified-package-v2/win-unpacked' '.pangea-build/flow-runtime-next'
```

证据目录必须不存在，脚本不会替换已有 Run 或证据。该探针需要本工作区的已组装源码回归脚本，实际 Python、Node、Skill、Archify 使用待验包中的版本。

## 真实宿主与界面验收

通过产品新建表单选择实际 OpenCode `minimax-cn-coding-plan/MiniMax-M2.7`，导入合成 C 函数和 combined 报告，不查询内网：

- 任务：`task-20260908162628-34c052`。
- Run：`windows-request-c-handle-260909-01`。仅一个分析 Run。
- 主分析外部会话：`ses_f7e284541ffeApeIlRiMr2l2BF`。
- 五阶段全部完成，3/3 用例交付完整。初次用例缺观察字段由宿主续跑同一 Agent 修复。
- 发现模型投影不完整后，通过同一 OpenCode 会话继续修订，未由宿主或 Python 改写语义结论。修订后业务流程呈现 4 个主干步骤、3 个分支、0 个未关联用例；缺口细节包含源码位置、触发条件、外部结果和证据关联。
- 复核为 `UNRESOLVED`、`independent=false`；报告与源码版本关联和原始分支实测信息仍不足。`READY` 仅表示机械交付完整，不代表覆盖率提升或独立语义 PASS。
- 实际独立画图继承外部模型，成功图 `d1901b90-7c90-44d5-8944-946e9f1dbc77`；另一图 `00814e2a-9275-4a9d-9dc0-197273f3dbd8` 被单独取消，主分析继续执行且原成功图保留。
- 最终修复包重启后，从已有图创建修订 `35299432-7cea-426e-97af-e68bf142a521`，来源版本 7，实际完成为 `ready`。浏览器看到该图的中文 iframe、工具栏、主干与分支以及 HTML/SVG 导出入口。
- 最终图通过真实产物路由导出 HTML/SVG；SVG 经包内 Python XML 解析成功。最终图宿主会话 `session-4e282f17-dbb5-4f1b-a98a-d1a2f7e852fd` 没有错误的内置模型回合；修复前会话确有 `has no provider/model`。复验时该图的外部进程已退出。

证据位于 `.pangea-build/flow-runtime-final`（最终图导出及 `real-host-completion.json`），以及 `.pangea-build/flow-final-host-views.json`、`.pangea-build/flow-diagram-cancellation.json`。首轮语义修订前的投影与复核快照保存在 `.pangea-build/flow-runtime-verified`，修订记录见 `flow-agent-repair.log`。这些均为本地忽略的合成验收数据。

## 尚未满足的发布验收

| 项目 | 当前边界 / 下一次验收条件 |
| --- | --- |
| 内置 API 分析与画图 | 隔离实例未配置模型；配置测试模型后复跑相同任务和取消场景 |
| 其他真实外部 Agent | 本轮真实运行 OpenCode；未将可执行文件探测或 batch shim 视为 Claude、NGA、CodeAgent 的真实联调 |
| 内网 coverage-query | 未提供内部 Skill 与真实业务输入；需在本地安装并于可访问内网的环境验收，不提交内部脚本或凭据 |
| 真实覆盖闭环与独立语义复核 | 本轮仅合成输入，版本和分支数据不足；不能声称真实覆盖改善或独立审核通过 |
| 正式签名更新与安装回滚 | 本轮仅未签名解包包和迁移 helper；仍需正式候选包、签名校验及安装升级验收 |

本轮源码和文档仅在本地提交，未推送、合并或发布。测试实例保留运行，供用户手动体验。
