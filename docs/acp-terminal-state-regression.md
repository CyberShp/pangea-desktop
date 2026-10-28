# ACP 跨回合终态与长上下文验证（2026-10-29）

## 修复范围

基线为 Desktop `0f50d78`、组件锁定的 Companion `557fdfb`。

旧 Provider 每次开始 prompt 都清空当前工具状态。第一轮已经完成的工具，在第二轮收到不含 `status` 的迟到标题/内容更新后，会回退为 `unknown` 并重新计入活跃工具。第三轮续接被拒绝；Companion 可能暂停，CodeAgent 分支可能进入进程树回收。

补丁新增按 remote session ID 与 tool ID 保存的已接受终态索引。当前回合统计仍照常重置；只有 `tool_call_update` 可以回查终态。新 `tool_call` 不继承旧终态，明确的 pending/in_progress 会清除缓存，未知工具仍阻断续接。未通过 SDK 验证的原始通知不能写入终态索引。

修改保存于 `patches/@deepseek-ai+dsh-subagent-acp+0.1.1-rc.2.patch`，并已同步本地安装依赖。已在独立目录从未打补丁的依赖重放补丁，确认产物与测试使用的 Provider 完全一致。未修改 Companion 产品源码或组件锁定。

## 自动验证

- 新三轮终态回归在旧 Provider 下失败，修复后通过；覆盖 completed、failed、重复工具 ID 的新调用、未知工具，以及其他会话的终态不能借用。
- Desktop 五个相关测试文件：82 项通过，1 项 Python API 集成因未配置运行时跳过。
- `test/acp-companion-continuation.test.mjs` 接真实 Companion 控制器、真实 Provider、ACP SDK 与独立协议子进程。三种 provider 配置各覆盖同 action 三轮和跨 action 三轮，共 6 项通过：只创建一个 worker，一次握手加三次任务，无误暂停、无额外补发、无回收、无提前 dispose，最终绑定不阻塞。
- 上述跨 action 的三种配置，换回旧 Provider 时均失败。这里的 Graph adapter 与 Agent 内容是测试替身，不能视为真实 NGA/CodeAgent 模型验收。
- Companion 原有 progress/recovery/source-first：73 项通过，4 项真实 Python Graph 集成因缺少运行时配置跳过。
- TypeScript 检查通过；未构建正式安装包，未提交、推送或发布。

跨仓库测试入口：

```sh
PANGEA_TEST_COMPANION_ROOT=/absolute/path/to/dsh-pangea/plugins/dsh-pangea-companion \
  node --test test/acp-companion-continuation.test.mjs
```

## OpenCode + MiniMax-M2.7 实际测试

OpenCode `1.18.4` 的 `opencode/minimax-m2.7` 网关凭据已过期。实际成功测试使用已有 MiniMax Coding Plan 凭据，经仅对子进程生效的自定义 provider 配置调用 `MiniMax-M2.7`；会话导出确认实际 modelID 为 `MiniMax-M2.7`。没有修改全局配置或复制明文凭据到报告。

`scripts/verify-opencode-acp-long-context.mjs` 在独立目录、同一个真实会话内执行三轮长文件读取。每个文件 800 行，合计 360,111 字节。逐条核对已完成 read 工具的 offset/limit 后，三个文件的 800 行均覆盖；不是只看模型声称读完。

| 回合 | 成功 read 调用 | ACP 报告的上下文 used / size | 结果 |
| --- | ---: | ---: | --- |
| 1 | 6 | 78,625 / 196,608 | completed，末行标记正确 |
| 2 | 6 | 146,422 / 196,608 | completed，末行标记正确 |
| 3 | 7 | 40,901 / 196,608 | completed，末行标记正确 |

宿主只发送三条计划内 prompt，后两次发送前 activeToolCount 与 unclosed_count 都为零。工具共 19 次，所有回合结束时工具均闭合。第三轮的会话导出存在 `compaction`，`auto=true`、`overflow=false`，以及成功的 summary 响应；OpenCode 自动压缩后继续完成，无需手动 compact。会话里的英文 `Continue if you have next steps...` 是 OpenCode 内部生成的 synthetic 消息，不是第四条宿主 ACP prompt。

真实会话 ID：`ses_e7c59249dffe062dQJm4lKT4KH`。测试结束后 Provider 确认进程退出。

通用真实测试入口（模型必须已在测试子进程中配置）：

```sh
PANGEA_TEST_ACP_CWD=/absolute/new/isolated/probe \
PANGEA_TEST_ACP_MODEL=provider/MiniMax-M2.7 \
  node scripts/verify-opencode-acp-long-context.mjs
```

探针保留默认自动压缩行为；可用 `OPENCODE_CONFIG_CONTENT` 设置子进程专用 provider，并通过 `PANGEA_TEST_ACP_FORWARD_ENV` 显式转发该 provider 所需的环境变量名。证据目录必须是新的，避免覆盖旧记录。

## 未关闭的问题

本次修复和验证关闭的是跨回合终态丢失，以及它触发的 Companion 误暂停/回收路径。真实 MiniMax 长上下文实验未复现用户报告的“突发宿主命令导致上下文超限并卡住”。不能据此宣称用户原始故障全部修复，也不能外推 Windows、NGA 或 CodeAgent 的真实模型链路已经通过。

进一步定位原始故障需要对应现场的宿主 prompt 时间线、ACP 工具终态和模型输入超限事件，以辨别宿主请求、模型内部继续和自动压缩消息。当前测试已保存这些维度的对照证据。

本地原始证据保存在 `/Volumes/Media/pangea-qa/acp-continuation-20261029/`：`provider-final.log`、`companion-integration-final.log`、`companion-final.log`，以及 `minimax-long-context/` 内的 `events.jsonl`、`opencode-session.json`、`result.json`、`verified-summary.json`。

## 推送前合并验证

推送时远端已更新到 Desktop `de92802`，Companion 锁定为 `63349b7`。已保留远端显式停止与升级相关修改，合并补丁并重新验证：ACP diagnostics/provider-launch/provider-patches/Windows fence 共 82 项通过、1 项跳过；从 `63349b7` 导出的隔离 Companion 上，6 项三轮集成全部通过。此轮未重复调用真实模型；上文真实模型证据仍对应修复最初验证时的版本。
