# Windows 首次验证

## 1. 构建便携包

在 Windows x64 PowerShell 中运行：

```powershell
node .\scripts\generate-update-key.mjs --output .\.pangea-keys\update-private.pem
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-pangea-desktop.ps1 `
  -UpdatePrivateKeyPath .\.pangea-keys\update-private.pem
```

脚本会完成组件提交校验、Python Runtime 组装、PANGEA JSON API 冒烟、TypeScript 检查、关键测试和 ZIP 打包。最终文件应为：

```text
dist\pangea-desktop-<version>-windows-x64-portable.zip
dist\pangea-desktop-<version>-windows-x64-portable.zip.sha256
```

## 2. 在空环境启动

1. 在没有 Python、pangea-agent 和 dsh-pangea 的 Windows 用户环境中创建一个可写目录。
2. 把便携包完整解压到该目录，运行 `PANGEA Desktop.exe`。
3. 确认主界面中存在 PANGEA Analysis 与 Assets 入口。
4. 断开外网后重启一次，确认入口仍存在。

## 3. 检查内置 Runtime

```powershell
$root = Join-Path $env:APPDATA 'pangea-desktop\launch-root'
Test-Path (Join-Path $root '.agents\pangea\dsh.md')
Test-Path (Join-Path $root 'pangea-data\repositories')
```

两项都应返回 `True`。程序目录的 `resources` 下还应存在：

```text
pangea-manifest.json
pangea-python\python.exe
pangea-runtime\src\pangea_agent\cli\main.py
app\node_modules\dsh-pangea\package.json
app\node_modules\dsh-pangea-companion\package.json
app\node_modules\dsh-pangea-asset-catalog\package.json
update\apply-portable-update.ps1
update\pangea-update.json
update\pangea-update-public-key.pem
update\pangea-package-manifest.json
update\pangea-package-manifest.json.sig
```

## 4. 验证真实 PANGEA 调用

1. 把一个小型 C/C++ Git 仓库完整复制到 `pangea-data\repositories\<repo-id>`。
2. 在 PANGEA Analysis 中创建 Run，明确选择仓库、分析目标和最小源码范围。
3. 确认 Run 已写入 `pangea-data\runs`，并能在界面中读取阶段、风险、用例和报告状态。
4. 在 Assets 中导入一个需求或历史缺陷文件，确认资产记录与提取状态可见。

## 5. 验证 DSH 内导包升级

1. 使用同一发布密钥生成两个不同版本的 ZIP，把较新 ZIP 复制到一个模拟内部共享目录。
2. 启动旧版本，在 DSH 设置区域点击“导入升级包”，选择较新 ZIP。
3. 确认校验完成后出现“重启并升级”。有分析会话运行时点击它，应用必须拒绝退出。
4. 分析结束后重启升级，确认版本变化、`%APPDATA%\pangea-desktop` 数据保留，并且程序目录旁存在 `.previous` 版本。
5. 分别选择损坏 ZIP、被修改文件的 ZIP、旧版本 ZIP，确认均被拒绝。
6. 使用无法进入 Harness Ready 的测试构建，确认程序目录自动恢复并重启上一版本。

完整语义分析仍需使用真实 Worker/Reviewer 流程验证，不能用单独的 CLI 冒烟代替。
