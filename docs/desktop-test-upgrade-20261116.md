# PANGEA Desktop test 升级与组件锁定

本轮 test 指 `.github/workflows/release.yml` 的 channel=test 产物，不是独立 UIUX Dev 工作流。

## 改动

- 默认基础版本从 2.1.9 调整为 2.1.26；发布版本仍由工作流生成 `2.1.26-test.<run>.<sha>`。
- 解析目标版本后检查当前升级最低来源策略，阻止构建低于门槛的目标。最低来源仍为 2.1.23，不放宽包校验。
- 保留现有 test → beta/latest.json 与 stable → stable/latest.json 分流。应用没有自动跨通道升级。
- Desktop 组件清单锁定 companion 0.11.1 对应的 dsh-pangea 提交；pangea-agent 锁定不变。
- 签名更新集成套件同时运行 stable/test：真实生成签名整包、补丁与上传索引，验证版本查询、下载、签名验证、补丁/整包选择、准备安装及交接计划。

## 验证结果

- 更新相关 Vitest：43 项通过，其中 stable/test 更新管理器集成 30 项。
- 发布版本、历史补丁及默认 test 构建保护：Node tests 38 项通过。
- TypeScript 检查通过；Electron main/preload 构建通过。
- Windows 启动器在集成测试中为替身，不能据此声称完成 Windows 原生升级验收。

## 发布与实机验收

先推送组件提交，再推送 Desktop 组件锁定。构建并发布 test A/B，按生成的 intranet-upload-list.json 上传 beta/<version> 制品，最后发布 beta/latest.json。仅在 GitHub 发布 prerelease 不会自动将文件部署到内网存储。

实机验收：在 A 内检测并升级到 B，确认实际运行版本、companion 0.11.1、仓库/任务/模型配置/local-skills 保留，并继续执行第二次打桩。至少验证精确补丁与缺补丁整包两条路径，以及安装失败恢复。

本轮未推送、未发布 test 成品、未操作内网存储；不能从当前本地组件锁定直接在远端构建，必须先推送对应组件提交。
