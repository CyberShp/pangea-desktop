# Mac 验收输入

这是一套可导入产品的小范围静态分析输入。`keyring-source/` 为真实 SPDK 源码，固定提交 `b95c6aa3342e6af15c0f90066600794b4673f690`，保留 BSD-3-Clause LICENSE；只包含六个文件，不可据此直接编译完整 SPDK。

`coverage-synthetic.combined.json` 的计数与分支坐标全部是合成合同数据，未运行 SPDK、未采集代码覆盖率。用它检查文件导入、源码匹配、未知分支保留及补测设计，不用于宣称真实覆盖率、提升效果或产品实测通过。无真实平台地址、用户源码或凭据。

仅把 `keyring-source/` 作为源码仓库；`branch-task.txt` 供目标描述，JSON 通过覆盖率文件入口导入。不要把本 README、验收文档或旧试点答案提供为被测 Agent 的业务事实。

合成 JSON 依据组件锁中的 pangea-agent `aeb0d95d6c96731396aeabcab7be4b4acf13326b` 的 `documents/coverage.py::parse_coverage_combined` 和 `assets.py` 文件导入合同准备。真实分支语义由模型读取源码核实，采集分支编号不代表源码 true/false。

人工验收流程见包内 `验收说明.md`，或仓库 `docs/macos-acceptance.md`。
