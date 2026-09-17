# 便携版升级目录占用恢复

适用：Desktop 已导入并验证补丁，重启升级时提示安装目录访问被拒绝，随后原版重新启动。

2026-09-17 的日志停在 `42% Preparing the new version`，没有 `indexing ... target files`。旧助手在补丁重建前移动整个安装目录；该阶段目录访问失败会立即中断。日志不能区分目录句柄占用和 ACL 权限问题。

## 修复行为

- 先从原安装目录读取未变更文件，在同级候选目录重建、校验并复制 `launch-root` 和 `local-skills`，最后才切换目录。
- 目录改名最多重试 30 秒。记录源、目标、系统错误和仍在安装目录中运行的进程；不强制结束这些进程。
- 使用精确目录改名，拒绝已存在的目标，避免意外嵌套移动。每次备份使用独立名称，不删除之前失败留下的备份。
- 回滚失败也保存升级结果和备份位置；未恢复成功时保留候选目录及备份，不冒充恢复成功。

## 为 1.0.3 恢复已导入的 1.0.4 补丁

旧应用执行的是旧升级助手，新包本身无法修复首次升级所用的助手。以下入口直接调用修正后的助手，复用旧应用已通过签名校验后保存的升级计划，并再次验证包大小、SHA-256、补丁基础版本和重建文件。它不修改原安装包或已安装文件来绕过签名。

1. 下载仓库的 `scripts/resume-portable-update.ps1` 和 `build/apply-portable-update.ps1`，放在同一个独立文件夹，例如 `D:\Agent\pangea-update-recovery`，不要放进安装目录。
2. 等分析任务结束，退出 Desktop，关闭以安装目录及其子目录为当前目录的终端。恢复入口遇到仍在安装目录运行的程序会停止并列出 PID；不会替用户杀进程。
3. 从安装目录外打开 Windows PowerShell，执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "D:\Agent\pangea-update-recovery\resume-portable-update.ps1" -InstallRoot "D:\Agent\pangea-desktop" -TargetVersion "1.0.4"
```

脚本在 `%APPDATA%\pangea-desktop\updates` 查找该安装路径及目标版本最新的原始升级计划。只支持已经导入的补丁，不接受未验证的新 ZIP。原始计划不会覆盖；恢复计划使用新文件并清除失效的旧进程 ID。若自动选取不是所需计划，可显式传入 `-PlanPath`。

升级日志仍在原导入目录的 `apply-update.log`。成功后自动启动新版，原 Run 保持原路径和编号。若目录一直被占用或权限不允许改名，30 秒后停止；原版仍保留，不保证重试能解决永久占用或 ACL 问题。

复用旧 1.0.4 补丁不会改变其内容；其中携带的旧升级器也不会被这次恢复脚本偷偷替换。后续正式构建才会包含新的升级助手。

## 验证

`scripts/verify-portable-update-locks.ps1` 在 Windows 上建立真实目录句柄，验证持续占用时原目录不变、短暂占用释放后成功、目标存在时拒绝覆盖，以及回滚改名保留文件内容。`verify-portable-patch-apply.ps1` 验证补丁重建及 Run/skill 保留。专用 Windows CI 运行两者，Linux 上的单元测试不能替代该验证。
