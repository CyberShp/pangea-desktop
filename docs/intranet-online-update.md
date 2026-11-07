# 内网 HTTP 更新源（Windows x64）

复用现有存储服务的 HTTPS 下载接口，不部署 Nginx，也不挂载 NFS。
旧版用户需先通过离线导入升级到包含本功能的 Desktop。

## 客户端使用

Windows x64 客户端固定使用内置内网源，无需填写地址。正式版读取
`stable/windows/x64/latest.json`，测试版读取 `beta/windows/x64/latest.json`。
设置页、菜单和错误提示均不再提供更新网络配置入口；旧 `update-network.json` 不再读取。
启动自动检查，下载和重启安装仍分别由用户触发；保留离线升级包导入。

客户端没有 GitHub 更新或回退路径。所有制品 URL 及重定向必须与内置索引同源。
支持 `?path=...` 查询相对地址。使用独立 Electron 会话和系统网络/PAC，
证书正常验证；企业 CA 由系统信任链处理。

## 构建自动产物

新版本 `build` 模式在历史补丁校验完成后自动生成 `latest.json` 和 `intranet-upload-list.json`，
同时附加到 workflow artifact 和 GitHub Release。大包的服务端名称固定为 `pangea-desktop.zip`，
补丁保留原名。无需在 CI 配置内网域名，也不会访问内网。

构建生成的 URL 使用 `?path=stable%2Fwindows%2Fx64%2F...` 查询相对地址，Desktop 沿用
用户配置的索引 URL 的 HTTPS 域名、端口和下载接口路径。用户仍填写完整的索引下载 URL。
默认 `path` 相对于工具根，没有额外根前缀。索引内的相对 URL 不能单独当作浏览器完整地址。

旧构建不会追加这些文件；需用包含此改动的提交重新构建。`backfill` 只补发历史补丁，
不覆盖已发布索引；需要使用下面的脚本从完整制品集合重新生成内网索引。

## 手动生成／上传准备

将一个目标版本的以下原始 Release 附件下载到独立目录：

- `pangea-desktop-{version}-windows-x64-portable.zip`
- `pangea-desktop-update.json`
- `pangea-desktop-update.json.sig`
- 需要支持的各基线补丁 ZIP（可选）

不要解包再压缩，不要编辑原始签名清单。使用项目可信公钥，不使用来源不明的公钥；
上传工作站不需要私钥。

```powershell
node scripts/create-intranet-update-index.mjs --directory D:/release-upload --public-key D:/keys/pangea-update-public-key.pem --download-url "https://{api_host}/api/tools/{tool_id}/files/download" --root "" --full-remote-name pangea-desktop.zip
```

`--full-remote-name pangea-desktop.zip` 指定服务器完整包文件名。省略时沿用原始文件名。
本地待校验 ZIP 保留 GitHub 原名，脚本不会改写 ZIP 或签名清单；上传清单会将本地原名映射到服务器新名。
若本地也已改名，请先恢复为签名清单中的原名再生成索引。

省略 `--download-url` 时生成上述查询相对地址；提供该参数时仍可生成完整绝对地址。

`--download-url` 填不含 `path` 参数的下载端点；其他必要查询参数会保留。
如果下载接口的 `path` 相对于工具根，`--root` 留空。若接口要求带存储根前缀，
通过 `--root` 传入该前缀。脚本通过 URLSearchParams 编码完整路径，不把查询式 URL 当目录拼接。
构建生成的相对索引不含部署域名，客户端内置部署端点。

脚本验证清单签名、完整包大小和 SHA-256、补丁清单签名与目标版本，生成：

- `latest.json`：客户端入口索引。
- `intranet-upload-list.json`：每个文件的上传路径、下载核对 URL，以及最后发布的入口 URL。

目录为 `stable/windows/x64/{version}/`；签名通道 `test` 映射到 `beta/windows/x64/{version}/`。
入口分别是 `stable/windows/x64/latest.json` 和 `beta/windows/x64/latest.json`。
每个基线只能有一个补丁；不要将不同目标版本的附件混在同一目录。

## 发布顺序

1. 按 `upload_first` 上传该版本的完整包、补丁、清单和签名。
2. 从下载接口回读，核对文件大小及 SHA-256。版本目录发布后保持不变。
3. 全部验证成功后，才把 `latest.json` 上传覆盖到 `publish_last.path`。
4. 在 Desktop 中检查、下载并安装，无需配置入口。

同名覆盖能力不等于原子覆盖；入口覆盖期间若读到不完整 JSON，客户端报错并等待重试，
不会开始安装。请求携带 Cache-Control: no-cache，发布后还需核对服务实际返回的索引版本。

## 索引契约

```json
{
  "schema_version": 1,
  "product": "PANGEA Desktop",
  "channel": "stable",
  "platform": "win32",
  "arch": "x64",
  "version": "2.1.16",
  "manifest_url": "https://updates.example/download?path=stable%2Fwindows%2Fx64%2F2.1.16%2Fpangea-desktop-update.json",
  "signature_url": "https://updates.example/download?path=stable%2Fwindows%2Fx64%2F2.1.16%2Fpangea-desktop-update.json.sig",
  "full_url": "https://updates.example/download?path=stable%2Fwindows%2Fx64%2F2.1.16%2Fpangea-desktop-2.1.16-windows-x64-portable.zip",
  "patches": []
}
```

每个补丁项包含 `name`、`from_version`、`to_version`、`size`（字节）、`sha256`、`url`。
脚本生成这些字段，无需手填。索引本身不签名，只用于发现制品；不能代替原有签名验证。
客户端先验证原始完整包清单签名与通道、平台、版本及最低源版本，再选择补丁。
仅当补丁源版本与当前完整版本字符串相等、目标版本匹配且体积小于完整包时优先选补丁；
没有匹配补丁或补丁更大时使用完整包。

下载后检查大小和哈希，再复用完整包或补丁内部签名、文件校验以及安装准入。
补丁内部基线与目标版本还必须与选定索引一致；索引哈希被同步篡改也不能绕过内部签名。
补丁下载或验签失败会明确报错，不自动再下载完整包；可修正发布索引或离线导入完整包。
当前下载失败删除临时文件，重试从头开始；服务的 Range 能力尚未用于断点续传。

## 验证范围

自动测试覆盖查询参数 URL、自定义端口、同源限制、重定向拒绝、最低版本、通道隔离、
匹配补丁、无匹配时全包、篡改数据及篡改哈希后的签名拒绝、旧配置忽略及设置入口删除。
集成测试使用真实签名全包/补丁及索引生成 CLI，网络和 Windows 安装器启动为模拟。

实机验收仍需内网 Windows：企业 CA、真实大包上传与回读、完整包升级、精确基线补丁升级、
任务运行时的安装准入、升级重启与失败回滚。不把 Linux 构建或模拟测试当作内网实机验收。

## 面向用户的更新日志

在 `build/release-notes.json` 中按目标版本维护 `features`（新增功能）、`fixes`（问题修复）、
`notices`（升级注意事项）三个文本数组。只写用户可理解的行为变化，不写代码差异、函数名、
提交哈希或原始提交列表。空分类不显示。正式构建会自动将对应版本的说明和生成时间写入
`latest.json` 的 `release_notes` / `published_at`，无需另上传日志文件。
测试构建可使用完整版本条目，否则使用其数字版本的条目；不匹配的版本不复用旧说明。
手动生成索引时可用 `--release-notes ./build/release-notes.json`。

自动检查只显示右上角轻提醒，同一版本跨重启不重复提醒；点击查看才打开说明弹窗。
手动检查发现新版直接打开弹窗。设置页保留“查看更新日志”入口，关闭弹窗不会下载或安装。
下载与安装均由用户分别确认。旧索引没有日志时显示“此版本未提供更新说明”，仍可下载。
说明使用纯文本显示，不执行 HTML；索引中的说明仅供阅读，不替代制品签名验证。
