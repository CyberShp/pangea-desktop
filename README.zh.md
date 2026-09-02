# PANGEA Desktop

PANGEA Desktop 是面向 Windows 的便携式 PANGEA 分析产品。一个 ZIP 同时包含 DSH Desktop 外壳、PANGEA 工作台插件、固定版本的 `pangea-agent` Runtime 和内置 Python。

三个实现仓库仍然独立维护。[`pangea.components.json`](./pangea.components.json) 记录来源分支、已确认的准确提交和 Runtime 下载。云端发布会把这些锁定提交放进临时目录，并将它们写入包内清单。升级组件与创建新安装包版本是两个独立操作。

当前组件组固定运行 `codetalks-skill 1.0.0`。每个 Run 都冻结自己的 Skill 副本，工作台只从持久化 Run 状态展示冻结版本和当前步骤编号。

## 在 Windows x64 构建

准备 Git、Node.js、npm、PowerShell 5.1 或更高版本，并确保构建机能访问代码仓、Python.org 和 PyPI。

```powershell
git clone ssh://git@ssh.github.com:443/CyberShp/pangea-desktop.git
cd pangea-desktop
node .\scripts\generate-update-key.mjs --output .\.pangea-keys\update-private.pem
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-pangea-desktop.ps1 `
  -UpdatePrivateKeyPath .\.pangea-keys\update-private.pem
```

构建结果：

```text
dist\pangea-desktop-<version>-windows-x64-portable.zip
dist\pangea-desktop-<version>-windows-x64-portable.zip.sha256
```

把 ZIP 解压到可写目录，直接运行 `PANGEA Desktop.exe`。应用数据始终保存在 `%APPDATA%\pangea-desktop`，替换程序目录不会删除工作区和 Run。首次 PC 验证见 [`docs/windows-validation.md`](./docs/windows-validation.md)。

## DSH 内导包升级

同一个 Portable ZIP 也直接作为升级包。把云端构建得到的 ZIP 搬到内部共享位置；用户下载后，在 DSH 设置区域选择“导入升级包”，校验通过即可重启升级。PANGEA Desktop 会校验 ZIP 内置的 Ed25519 签名文件清单。

升级助手会保留上一版程序目录，只有新版本 Harness 成功进入 Ready 才确认升级，否则自动恢复。应用数据始终位于程序目录之外。发布密钥和内部交付步骤见 [`docs/release-runbook.md`](./docs/release-runbook.md)。

## 运行目录

- 产品 Runtime：解压目录下的 `resources\pangea-runtime` 和 `resources\pangea-python`。
- 可写产品工作区：`%APPDATA%\pangea-desktop\launch-root`。
- 待分析仓库：`%APPDATA%\pangea-desktop\launch-root\pangea-data\repositories`。
- Run、资产和报告：`%APPDATA%\pangea-desktop\launch-root\pangea-data`。
