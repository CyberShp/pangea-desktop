# Windows 首次验证

## 1. 构建安装包

在 Windows x64 PowerShell 中运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-pangea-desktop.ps1
```

只需要预先 clone `pangea-desktop`。脚本会把另外两个仓库的锁定提交取到临时组装目录，不要求长期维护额外 checkout。如果 Windows 机器已经有内部镜像，可选传入 `-DshPangeaSource` 和 `-PangeaAgentSource`，但脚本仍会重新提取干净的锁定提交，不会打包本地未提交修改。

脚本必须依次完成组件提交校验、Python Runtime 组装、PANGEA JSON API 冒烟、TypeScript 检查、关键测试和 NSIS 打包。最终文件应为：

```text
dist\pangea-desktop-windows-x64-setup.exe
```

## 2. 在空环境安装

1. 在没有 Python、pangea-agent 和 dsh-pangea 的 Windows 用户环境中运行安装包。
2. 启动菜单和桌面快捷方式应显示 `PANGEA Desktop`。
3. 首次启动应进入 DSH 主界面，并能看到 PANGEA Analysis 与 Assets 入口。
4. 断开外网后重启一次，PANGEA 入口仍应存在；这验证插件不是首次启动联网安装的。

## 3. 检查内置 Runtime

```powershell
$root = Join-Path $env:APPDATA 'pangea-desktop\launch-root'
Test-Path (Join-Path $root '.agents\pangea\dsh.md')
Test-Path (Join-Path $root 'pangea-data\repositories')
```

两项都应返回 `True`。安装目录的 `resources` 下还应存在：

```text
pangea-manifest.json
pangea-python\python.exe
pangea-runtime\src\pangea_agent\cli\main.py
app\node_modules\dsh-pangea\package.json
app\node_modules\dsh-pangea-companion\package.json
app\node_modules\dsh-pangea-asset-catalog\package.json
```

## 4. 验证真实 PANGEA 调用

1. 把一个小型 C/C++ Git 仓库完整复制到 `pangea-data\repositories\<repo-id>`。
2. 在 PANGEA Analysis 中创建 Run，明确选择仓库、分析目标和最小源码范围。
3. 确认 Run 已写入 `pangea-data\runs`，并能在界面中读取阶段、风险、用例和报告状态。
4. 在 Assets 中导入一个需求或历史缺陷文件，确认资产记录与提取状态可见。

本阶段的验收重点是“安装后能启动、入口存在、内置 Runtime 能被插件调用、数据写入应用目录”。完整语义分析仍需使用真实 Worker/Reviewer 流程验证，不能用单独的 CLI 冒烟代替。
