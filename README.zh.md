# PANGEA Desktop

PANGEA Desktop 是面向 Windows 的 PANGEA 分析产品。一个安装包同时包含 DSH Desktop 外壳、PANGEA 工作台插件、固定版本的 `pangea-agent` 源码 Runtime，以及内置 Python Runtime。

三个实现仓库仍然独立维护。[`pangea.components.json`](./pangea.components.json) 固定每个安装包使用的提交和 Runtime 下载。构建时只把对应提交放进临时目录，不把另外两个仓库的源码合并进本仓库。

## 在 Windows x64 构建

准备 Git、Node.js、npm、PowerShell 5.1 或更高版本，并确保构建机能访问代码仓、Python.org 和 PyPI。

```powershell
git clone ssh://git@ssh.github.com:443/CyberShp/pangea-desktop.git
cd pangea-desktop
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-pangea-desktop.ps1
```

如果内部已经有另外两个仓库，可直接传入本地路径。构建脚本仍会检出版本锁中的提交，不会把工作区里的未提交修改装进安装包。

```powershell
.\scripts\build-pangea-desktop.ps1 `
  -DshPangeaSource D:\src\dsh-pangea `
  -PangeaAgentSource D:\src\pangea-agent
```

NSIS 安装包位于 `dist\pangea-desktop-windows-x64-setup.exe`。首次 PC 验证见 [`docs/windows-validation.md`](./docs/windows-validation.md)。

## 安装后的目录

- 只读产品 Runtime：安装目录下的 `resources\pangea-runtime` 和 `resources\pangea-python`。
- 可写产品工作区：`%APPDATA%\pangea-desktop\launch-root`。
- 待分析仓库：`%APPDATA%\pangea-desktop\launch-root\pangea-data\repositories`。
- Run、资产和报告：`%APPDATA%\pangea-desktop\launch-root\pangea-data`。

继承自上游 DSH 的公开发布流水线已停用。在内部产物地址和签名方式确定前，产品不会连接外部更新源。
