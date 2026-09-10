# PANGEA Semantic 配套版本

Desktop 和 DSH 均从各自的 `codetalks-skill` 新建
`langgraph` 分支。Desktop 基线为 `8395d59`，DSH 基线为
`48b7921`。固定版本以仓库根目录 `pangea.components.json` 为准：

| 组件 | 分支 | 固定提交 |
|---|---|---|
| pangea-agent | langgraph | 58398f10ef7663b23c24310f932a76d77254d0d2 |
| dsh-pangea | langgraph | c4d60c7ad4a9fbfffe848b7d6b537bbec802eb00 |

Desktop 加载 companion 与 report-policy，打包 Agent 的 `.agents`、`.opencode`、
Python 源码与 schemas。启动时将客户端规则和工具同步到产品工作目录。
打包检查核对固定组件提交、source-first 接口及必需的 OpenCode 工具文件。

DSH companion 负责任务创建、任务和 Run 绑定、source-first 工具、进度与原文记录、
报告打开以及 ACP 状态结算。任务的上下文预算会随保存和重新读取保留。
ACP 结算读取 source-first 正式报告；宿主 Job 使用编号和启动时间共同定位。

## 开发与验证

两个独立工作目录：

- `/Volumes/Media/dsh-pangea-semantic-adaptation`
- `/Volumes/Media/pangea-desktop-semantic-adaptation`

Desktop 在本目录安装锁定依赖后运行：

```text
npm test -- test/pangea-product.test.ts test/release.test.ts test/semantic-staging.test.ts
npm run typecheck
npm run build
```

DSH 检查与真实 CLI 集成方式见配套仓库的 `SEMANTIC_ADAPTATION.md`。
开发验收必须核对 Harness profile 的 `profiles/node_modules/dsh-pangea*` 最终路径。
共享旧目录的 DSH 启动器会使安装根目录回到旧工作树；验证环境中的启动器必须位于
当前 Desktop 依赖树，插件最终路径必须指向本次配套 DSH。

Windows x64 组装继续使用 `scripts/build-pangea-desktop.ps1`。
GitHub 构建前须先推送 DSH 配套提交和 Desktop 分支，再执行既有构建工作流。
本次交付为本地 Git 提交。

## 验收边界

- 本地 DSH 插件检查：67 项通过，包含真实 Python CLI 的创建、绑定、规划、
  结算、恢复同一 Run、上下文预算保留、读取和停止检查。
- Desktop 运行环境与组装元数据检查：12 项通过；类型检查、构建通过。
- 真实客户端使用独立开发 profile 和临时样例仓库，走 Desktop → DSH →
  OpenCode ACP → MiniMax M2.7。最终结果与加载路径证据保存在本地
  `.pangea-build/semantic-validation/`。
- 最终样例 `semantic-sample-c-260910-04` 为 `complete / PASS`，ACP 执行状态
  为 `completed`，上下文预算为 204800，两轮审查复用同一 Reviewer 会话。
  页面已验证任务状态、首页报告数量和 HTML 报告打开。样例仅包含一个加法函数，
  生成 3 条开发辅助用例；该结果证明接入链路，不代表大型项目分析质量。
- 元数据检查中的 Python 文件是检查夹具；它不代表 Windows 安装包已构建。
- 尚未进行 Windows 便携包运行验证、DSH 内置 API 模型实跑或大型仓库质量验收。
