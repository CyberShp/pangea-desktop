# 原生执行证据实现审查

Review-Target-ID: feat-module-analysis-five-stages
Branch: feat/module-analysis-five-stages

What：给已有 Producer/Reviewer 链接入 Reviewer 编写、宿主原生执行、同一 Reviewer 判定的 C 验证程序，保留每轮原文及执行证据。
Why：文字复核仍然留下返回值和最终状态错误。原始需求与摘录见 `../native-case-execution-review.md`。
Tradeoff：当前只支持 Windows 和已配置受信任的 GNU 参数兼容 C 编译器；编译器用普通用户权限，生成程序使用 AppContainer。环境缺失只能报告未验证，不能降级普通执行或伪造质量结论。
Open：请重点检查绑定/路径、Windows资源释放和取消、Reviewer原样转录的可追溯性、非致命错误不终止Run。不要修改正在运行的验收任务或冻结材料。
Next：实现审查与实际模型验收都没有明显问题后，才允许推送目标分支并构建。

Architecture cell/Map delta/Why：见方案文档。沿用既有审查宿主与任务持久化，仅新增原生执行事实收集。

自检：Companion188项通过（包含源检查和客户端构建）；Agent运行时/阶段发布12项通过；原生隔离1项通过（文件/本机联网/超时继续）；执行证据3项通过（含真实源码编译错误返回反证）。实际Desktop 12790端口页面已打开，新Run06/07正在运行；质量验收未完成，不作发布放行。
证据：隔离测试根目录 `D:/pangea-e2e-targets/desktop-test79-20260909`，插件测试日志 `execution-verification/native-companion-tests.log`。

本次范围：Agent的case_verification.py、native_case_process.py、cli/main.py、两套executable-case-review.md及阶段04；Companion analysis-review.js、workbench-api.js、pangea-api.js、index.js及关联测试。既有未提交修改和历史验收失败保留。

## 复查结果

独立Reviewer发现并复查了编译子进程清理、强杀CLI跳过隔离回收、整文件读取三个问题。现已使用编译轮询及finally树回收、cancel-file协作退出、日志限量读取；单项ACL回收失败仍尝试其余回收，失败如实报告。新增真实编译子进程取消、真实CLI取消、受限进程取消后ACL回收回归。Companion190项、Agent17项通过。

基于实际模型暴露的探针转录问题，增加由原Reviewer修正探针并以verify请求重执行，保持同一Producer/Reviewer身份。独立代码复查未发现新的明显阻断项；仅代码审查通过，真实新候选质量未验收，不能据此发布。
