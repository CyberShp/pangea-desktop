# MiniMax 消息队列九步验收

2026-09-08，独立 PANGEA Desktop Dev 通过正式仓库导入、资产导入、任务创建与启动接口运行。持久化请求和响应记录确认使用 `minimax-1 / MiniMax-M2.7-highspeed`。

## 结果

- Run：`minimax-message_queue-sr-260908-01`，速度型 Step 01–09 与 finalize 完成，约 27 分钟。
- 目标为 69 行 C 实现和 19 行头文件的固定容量消息队列；冻结源码仅两个文件，分析后字节未变。
- 引用自创设计文档 `asset-260908-029` 和合成 XLSX 覆盖率 `asset-260908-030`，均为 revision 1。XLSX 包含 6 条函数记录及已覆盖、未覆盖场景。
- 实际生成 8 份正式 Markdown 报告。CSV/XLSX 经 Desktop 页面下载落盘，分别为 4864、21702 字节，单元格值一致。

流程完成和资产、下载链路通过；内容验收未全通过，不能把状态 `READY` 解释为报告全部正确。

## 介入及已修复缺陷

两次通过 Desktop 原会话纠偏：先要求 Agent 从只读 normalized/structured 结果改为实际读取冻结 XLSX 全部 7 列；后指出 Step 09 报错涉及“黑盒测试场景.md”，而 Agent 正在反复检查“黑盒测试流程.md”。没有代写报告、改写冻结输入或降低校验要求。XLSX 补读发生在 Step 04，未完全遵守覆盖率允许步骤 03/05/07。

导出最初缺少详细步骤和预期结果。读取器此前只补充活文档目录，且未识别本轮小写用例 ID、加粗字段与编号步骤。回归测试复现后，修复为消费已完成 Step 09 的正式用例文档，保留投影 ID 并匹配 TC 前缀标题，解析实际字段格式。工作台插件 127/127 测试通过。开发版重启后使用原 Run 重新导出，没有重跑分析。

## 未通过项

1. 投影有 26 条用例，正式文档仅有 22 条详细内容；`cap-01`、`cap-02`、`wrap-01`、`cycle-01` 缺少步骤和预期。读取器不能补造模型未交付的内容。
2. 设计明确允许 `mq_clear` 不擦除 slots。真正的缺陷是 `mq_peek` 使用 `offset > count`，错误放行 `offset == count`。报告把清空后旧数据可见另归因于未擦除存储，重复且错误地拆分了根因。
3. 报告保留了 int 入参没有 NULL 检查的所谓不一致，以及单线程约定范围外的并发高风险。覆盖缺口只能支持补测，不能直接证明代码缺陷。
4. 同一 Agent 自审未消除上述误判；结构和索引校验也未发现 4 条用例缺项。提示词约束已经加强，但语义质量问题仍未解决。

本轮没有编译执行生成的 C 测试，合成覆盖率不是真实执行数据。NGA/OpenCode 内网 PREPARING、CodeAgent 实机 shell 和原诊断 OOM 仍待实机证据。

本地完整证据保留在 `.pangea-build/minimax-queue-acceptance/`；原始 Run 位于独立开发版 `dist-dev/win-unpacked/launch-root/pangea-data/runs/minimax-message_queue-sr-260908-01/`。这些运行数据不随源码提交。
