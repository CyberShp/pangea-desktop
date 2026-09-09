# 覆盖率 Skill 与真实复核验收

最终结论（2026-09-10）：候选改动已落地并用实际Desktop完成4轮新任务验收。真实Reviewer派发、原会话定向修订、正式复查及状态展示有效；用例质量验收未通过，不能作为“质量问题已修复”发布。M2.7-highspeed和M3对照均有模型PASS却保留真实错误的情况。

| Run | 冻结覆盖率Skill | 模型 | 流程/用例 | 外部质量验收 |
| --- | --- | --- | --- | --- |
| 05 | 1.1.3 | M2.7-highspeed | 4 / 10 | 失败：重复准备、查询返回与清理描述 |
| 06 | 1.1.4 | M2.7-highspeed | 4 / 13 | 失败：连接后配置仍预期OK |
| 07 | 1.1.5 | M2.7-highspeed | 4 / 11 | 失败：Reviewer把正确预期改错 |
| 08 | 1.1.5 | M3（单独对照） | 5 / 13 | 失败：重复准备、错误末态、遗漏路径 |

## 本轮修改

- 当前覆盖率 Skill 1.1.5、模块 Skill 1.4.3。沿用 feat/module-analysis-five-stages，保留之前的解析修复。
- 缺口台账逐项记录目标函数/路径、实际覆盖事实、预期行为和处置；区分仅在准备阶段经过与由主要触发、断言验证。
- 写用例前沿冻结源码推演准备调用、真实返回值、状态变化、目标判断和 Oracle；不同预期路径独立成例，组合场景需有额外交互断言。
- 模板明确公开库接口可作为测试入口；白盒夹具条件不得冒充现成黑盒操作。清理说明对应实际资源和保留状态。
- Reviewer 逐例尝试推翻准备过程、断言、清理和关联结论；检查路径遗漏，保留问题、原 Producer 修订及同一 Reviewer 复查记录。
- 五阶段 ACP 深度任务由宿主派发真实 Reviewer，沿用现有执行器和 TaskStore，不以模型自报 ID 证明独立执行。程序仅校验当前任务、Run、会话及审查请求的绑定，消费 Reviewer 的 revise/accept/wait 决定，不判断用例语义质量。
- 正式输出也由原 Reviewer 复查。复核未结束时，界面不把模型自报 READY/PASS 呈现为宿主完成独立审核。

## 验收方法

实际 PANGEA Desktop test.79 解包目录应用本地源码补丁，原发布 ZIP 不变。实例为 D:/pangea-e2e-targets/desktop-test79-20260909/app，独立 profile 同级 profile。通过该 Desktop 启动的实际 Harness 产品页面创建任务；不是开发服务器或伪造 Run。

Run analysis-260909-05 使用同一份 82 行 C 模块、11 条中文函数覆盖率记录、OpenCode / minimax-cn-coding-plan/MiniMax-M2.7-highspeed，深度模式。已确认任务冻结覆盖率 Skill 1.1.3。生成10条用例、4个流程；11条原始覆盖记录完整保留，2条未知、1条原始路径缺失，4个已定位未覆盖函数属于目标范围，1个独立校验函数有据排除。

宿主实际 Producer 为 949fd64e-de38-4483-87f7-0966246ea8ca，Reviewer 为 af51d516-57b3-4577-8925-9d555abba56c；对应 ACP 会话分别是 ses_f796d0c57ffeHgfDMb0eA7ps7Z、ses_f7965e62cffe1G36QVNCQkfNBg。Reviewer 独立发现 TC-008/009 未建连提交命令的错误，原 Producer 增加建连操作后由同一 Reviewer 复查。正式输出复查又发现报告使用旧审查状态，再次交回原 Producer。

独立人工验收仍发现前置与步骤重复执行建连、计数查询返回1却总述全部返回OK、只清除部分字段却总述全部状态归零；因此不能将本轮模型PASS当成质量通过。1.1.4进一步明确按原文累计执行状态、前置与步骤不重复、逐调用返回和完整状态断言。Run05冻结内容不改，下一轮使用新任务验证。

## Run06：调度链路通过，质量失败

analysis-260909-06 冻结 Skill 1.1.4，源码和覆盖率原文件与 Run05 哈希相同。宿主实际 Producer 为 51aec59a-598c-429e-8e58-cad46cddcb60，Reviewer 为 0ebe3b2a-517b-43e3-be22-e93e3a5c37a3（ACP ses_f7952f788ffen36hRGrGfpKm6Y）。Reviewer 发现可达性误判、计数准备错误、遗漏的认证失败清理路径和台账未更新，两次交回原 Producer 修订。最终13条用例、4个流程，正式复核于2026-09-09 23:19:26 +08:00结束，模型PASS，宿主Job completed。

人工验收正式输出 TC-08：先 open_plain 建连，再 set_secret(s,2) 并预期 OK；源码在 connected=1 时返回 BUSY，准备步骤不成立。TC-06重复准备与TC-02整体清理描述也仍有问题。因此用例质量失败，不能把真实独立会话或模型PASS当作正确性保证。

1.1.5 将执行核对表放在分析和复核正文，要求逐步列出调用前状态、实际返回、变化及保留状态，审核建议本身也要推演。业务准备集中在编号步骤，最终用例只留一套有效操作；保留两端现有读取格式。范围外接口可以支持准备，包装入口的断言不机械拆成重复用例，函数计数不臆测所属场景。

## Run07：审核将正确预期改错，质量失败

analysis-260909-07 冻结 Skill 1.1.5，实际 Producer d26472d0-d3a1-4f70-9a69-539dd1ba07cd，Reviewer e1878cd1-7f26-4484-9786-1e11568e1721。源码和覆盖文件与Run06哈希相同。实际ACP读取记录确认生成者读了新版阶段03、模板和路径设计说明。

Reviewer 将 transport.c 第34行 credits=1 误认为先于第32行 INVALID 返回，要求把 TC-03 原本正确的 credits=0 改为1。原 Producer 接受，五轮复核后正式输出仍保留此错误；2026-09-09 23:37:30 +08:00宿主完成、模型PASS。11条用例已覆盖四个目标内未覆盖函数，并补出 open_secure BUSY，但质量验收失败。不能把新增审核次数、真实独立会话或规则已读取当作语义正确的保证。

## Run08：模型对照质量失败

analysis-260909-08 保持 Skill 1.1.5和相同输入，只在新任务中指定 minimax-cn-coding-plan/MiniMax-M3。此对照与M2.7结果分开，不修改默认提供方模型，也不用于宣称原模型已修好。13条正式用例、5个已解析流程，三轮真实复核于2026-09-09 23:57:27 +08:00结束，模型PASS，宿主Job completed。

外部两次独立静态核对确认：TC-COMPLETE-ADMIN-01/02等前置已建连，步骤再次open_plain却要求OK，实际BUSY；TC-DISCONNECT-01末尾重连后仍称已重置；回收用例只用completed=0验证保留，不能识别错误清零；没有实际触发authenticate(s,0)且secure=1的回收用例。同轨迹仅因FLOW视角不同重复成例。最终正式用例SHA256为EB68E8542590E733E228F29C502CFB79F4505F6A627C28EBCC464D3C950FCB31，内部复核结束后没有消除这些问题。

最终 Companion 回归187项通过，Agent相关回归13项通过；三个仓库diff检查通过。独立代码复查发现并修复五阶段适用范围、取消竞态、会话清理及终态标题问题。实际UI还发现Step03活文档被Step05同名正式输出覆盖归属，已改为完整路径匹配，回归先失败后通过。

所有任务结束后同步30个生产文件并逐项核对源码/运行时哈希，2026-09-10重启实际Desktop。最终实例PID121464，Harness PID148692，地址http://127.0.0.1:9525/。现场确认Step03显示覆盖缺口分析.md和黑盒测试用例.md，四轮宿主绑定保持complete，报告仍可读取。停止/失败标题以相关单元测试验证；未对这两条终态另造模型任务。client.js生成产物已同步。

运行时补丁清单见runtime-patch-manifest.json；host-e2e-start-patch-manifest.json记录本轮宿主启动版本，run07-skill-patch-manifest.json记录用于07/08的新Skill包。最后两处展示修复在端到端任务结束后同步，已用重启后的真实UI验证阶段文档展示，未改写任何Run。

## 边界

本次端到端验证对象是 Desktop 创建真实分析任务、冻结构造输入、实际模型生成及独立复核到正式交付的链路；用例内容由外部对照冻结源码逐项核对，没有编译或执行生成的C用例。流程或函数有关联用例不表示补测已经执行，更不表示实测分支覆盖率提高。

隔离profile没有配置默认内置API助手，页面保留配置提示，父对话可显示provider/model未配置错误；本次显式选择的OpenCode分析Job及其Reviewer已实际完成。未修改或补设用户的默认API配置，也不宣称默认内置助手已验收。

运行中由原会话定向修订和复查；捆绑 ACP 适配器尚未暴露进程重启后的 loadSession，受中断任务保留绑定并显示待恢复，不改派替代会话。内部 API、九阶段场景与历史 Run 仍如实显示其原审查方式。

组件锁定仍指向已发布提交；当前源码未提交、未推送、未出新包。真实内网版本查询不在本次最小模块验收范围，仍未验证。

## 主要实现位置

- Agent：codetalks-coverage-skill/steps/coverage-02-gaps.md、coverage-03-analysis.md、coverage-04-review.md、用例模板及路径设计/Worker-Judge协议；版本在skills.py、SKILL.md和workflow-manifest.json同步。
- Companion：src/analysis-review.js派发及续接真实Reviewer；src/workbench-api.js接入现有ACP执行器；src/task-store.js保存绑定；src/index.js展示任务真实复核状态；src/launch-log.js保存复核事件；src/client.js及已同步的lib/client.js展示审查方式与语义结论。
- 证据目录：D:/pangea-e2e-targets/desktop-test79-20260909。run05/06/07/08-independent-audit.md保存外部验收依据；各Run原始文件位于app/launch-root/pangea-data/runs，任务日志位于profile/harness/dsh-pangea-companion/launch-logs。
