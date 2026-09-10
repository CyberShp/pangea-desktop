# 资产消费与模型路由复核

## 所选资产是否真正交给 Skill

有明确的输入和消费流程：

1. 请求携带 asset_ids，skill_runs.py 调用 freeze_asset_inputs，将可用且完整性通过的资产冻结到当前 Run 的 inputs/assets，并记录 manifest、版本和哈希。
2. 启动提示词列出所选资产 ID、revision、类型、标题，要求只读冻结副本并遵守 manifest 的允许步骤。
3. Skill 0.2 规定：需求/设计在 02–04，Coverage 在 03/05/07，历史缺陷在 05，参考资料在 02–07 按相关性，用例示例仅在 07 作格式和粒度参考。
4. Skill 第 7 节要求每份材料进入输入材料索引，记录实际解析范围、工具、提取事实、消费 Pass/Flow/Scenario 和限制，禁止只确认文件存在。

实际 is_even Run 的输入材料索引记录了 asset-260908-024 和 025 的冻结路径、revision 1、已解析 1:2 行、提取事实及 used_by_passes 02/03/04。因此本轮不是所选资产没有传入；此前报告的问题是将已读取的设计注意事项错误推导为当前代码风险。机械索引不能代替 Agent/Reviewer 的语义判断。

## MiniMax 为什么没有用于上轮方法论验收

只读取必要字段后确认：用户原 Desktop profile 的 agent-default-model 是 minimax-1 / MiniMax-M2.7-highspeed，llm-pi-ai 已配置对应提供方及凭据引用。

上轮独立测试 profile 只有 ui-onboarding，没有该模型配置。方法论调用 sessions.create，再提交 worker 提示词，没有指定其他模型；DSH 新会话读取 agent-default-model。空白测试 profile 因而使用基础 bundle 内置的 deepseek-official / deepseek-v4-flash，并因无凭据失败。

这证明上轮失败来自测试 profile 与用户配置不同，不能归因于用户没有配置 MiniMax，也没有发现方法论强行覆盖 MiniMax 的代码。

## 已移除的官方入口

- PANGEA 产品 bundle 停用 llm-deepseek，不再注册该内置模型适配器及设置命名空间。
- 产品默认模型不再预置官方模型；已保存的 MiniMax 等自定义默认模型沿用原 DSH 设置。旧 deepseek-official 默认选择读出为空，要求重新选择，不修改用户保存文件。
- 模型设置统一过滤 llm-deepseek、deepseek-official 和 pi-ai 的内置 deepseek 提供方，保留 MiniMax 等提供方和自定义网关入口。
- 内置联网搜索也是调用 DeepSeek 官方 API 的辅助模型请求，因此同时停用 web-search-deepseek 及默认 web_search 工具。没有增加替代搜索或新的模型配置体系。
- 首次引导文案改为配置提供方并选择默认模型。

用户原安装目录、profile、凭据文件没有改写。验证只修改已有隔离开发实例；测试启动时仅读取当前 MiniMax 的凭据引用，并将对应凭据传入自有测试进程环境，没有输出凭据或复制用户凭据文件。

## 验证结果

- 新增测试先复现失败后转绿；相关 Desktop 模型测试 28/28，PANGEA 客户端测试 23/23，Desktop typecheck 通过，依赖补丁反向应用检查通过，安装脚本连续运行可重复。
- 空白配置真实启动：模型选择显示“选择模型”，设置页无官方 DeepSeek 项；提供方列表保留 MiniMax 和自定义提供方。
- 独立实例使用用户已有 MiniMax 配置后，通过同一个方法论生成接口完成真实生成和导入，耗时 34.8 秒。
- 会话 session-e7577ed8-398a-4000-b8ed-62c8b3aab55c 的持久化请求记录确认实际模型为 minimax-1 / MiniMax-M2.7-highspeed，没有 deepseek-official 请求。
- 生成候选 clamp-boundary-condition，来源为本轮合成历史缺陷 asset-260908-002，保持待启用；没有启动额外完整分析 Run，也不将生成成功等同于候选内容已获人工批准。

证据：.pangea-build/asset-acceptance-0908/multi/methodology-minimax.json、methodology-minimax-model.json。此前多任务报告中“内置方法论因缺凭据未通过”是旧测试 profile 的阶段结果，以本次复验更新；其他报告语义问题和真实内网 ACP 未解决项不因此关闭。

修改已同步独立解包实例，尚未提交、推送或发布。
