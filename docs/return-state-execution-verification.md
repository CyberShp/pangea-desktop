# 返回值与最终状态的执行验收

用户确认（2026-09-10）：优先处理“预期结果算错”和“最终状态描述错误”，修改生成及审核方法；在实际 Desktop 上分别验证模块分析、覆盖率分析。

## 诊断与实施

已证实问题：Run07 TC-03 将提前返回之后才可能执行的赋值算入预期；Run08 TC-DISCONNECT-01 在验证阶段重新建连后仍描述结束时已重置。隔离目录中的 prior_failures.c 直接包含冻结 transport.c 编译执行，得到三个矛盾：credits 期待1实际0，最终connected/credits期待0实际1。返回值及保留字段的对照检查正确。

原因：模型未稳定遵循实际控制流及累计状态；不同观测时点混用，审核建议也可能错误。不能用表格齐全或模型PASS作为正确性证明。

候选改动：覆盖率1.1.6、模块1.4.4，增加返回值/状态求值方法并由两套阶段03/04明确读取。先记录实际分支、执行语句、返回及状态，再写断言；Reviewer独立求值后比较，Producer核实修改依据。模板把所有业务调用放入编号步骤，并区分触发后、验证后、清理后的时点。保持现有语义权限、审核路由及文档解析格式。

Architecture cell：Agent Skill 方法论。Map delta：none。没有新增宿主语义检查、产品执行器、数据库或模型调用方式；C执行工具只在外部验收目录使用，不写入产品，也不向真实分析模型提供答案。

## 验收顺序

1. 旧版模块Skill1.4.3的新任务作为模块分析基线；覆盖率已有Run07/08作为基线。
2. 两套候选Skill相关回归检查、独立审阅。
3. 原基线任务完成后，同步候选源码到隔离test.79解包目录，重启自己启动的Desktop，新建两个任务；保持相同源码、模型M2.7-highspeed与深度模式。
4. 从正式用例逐条转录调用及断言，编译对应冻结源码并执行；保留用例原文哈希、转录位置、逐步真实返回和全部字段。不补写或省略原用例动作来凑通过。不可执行或不明确的条目单列，不能算通过。
5. 独立核对转录与原文。保留真实模型审查结论，同时以执行证据单独给出本轮质量结论。

源码修改完成，Companion187项与Agent13项回归通过；两套规则与模板已独立只读审阅。外部执行工具另外修正了参数缺失/非法不能默认为0、空用例或无断言不能成功，并保存每个Run的编译命令和源码/二进制哈希。

## 模块分析基线

analysis-260910-01：模块Skill1.4.3、M2.7-highspeed、深度模式，宿主完成且模型PASS。Producer 98d0bbcf-752c-4d51-af9f-98a943ca8fbe；Reviewer 5e6bee22-499a-4340-8a2a-4b643ab27bdc（远端ses_f78fea469ffey16xrSg4S4O1EK）。五轮复核修正了认证失败后提交返回值、部分状态描述等。

正式13条用例按原文转录并真实执行，48项明确返回/状态断言有3处矛盾：TC04/TC11前置已经建连，步骤再次建连期待0，实际-4；TC12 set_secret(s,3)期待0，实际-1。独立审阅确认转录忠实。TC01/TC10“初始状态”清理措辞歧义另列；TC09/TC10只有状态前置，执行使用显式记录的合法接口夹具，仅证明该夹具下结果，不表示原文独立可执行或任意初态已验收。

正式稿SHA256：D4D157459D88F6B7835526779767062FEBF6EB10F33FF1CDB9472A8575FC1D60。结论：模块分析也存在返回值算错，模型PASS不能证明用例正确。对应module-baseline.json与module-baseline.result.json。

## 候选实际任务

基线完成后同步34个生产文件并核对源码/运行时字节，重启自建隔离Desktop。PID108228，实际Harness子进程142984，页面http://127.0.0.1:12913/。生产发布ZIP不变。

- analysis-260910-02 / task-20260909164533-3b8f13：模块1.4.4。
- analysis-260910-03 / task-20260909164609-9f61b4：覆盖率1.1.6。

两者均M2.7-highspeed、深度模式、同一目标源码；已核对冻结的新规则与候选源码一致。输入证据见candidate-input-evidence.json，运行时同步证据见return-state-runtime-patch.json。

模块02正式稿23条用例：在记录的合法初态/准备夹具下，83个断言未发现数值矛盾；但初态、TC20/21计数前提及多处清理末态不完整，不能声称原文完整可执行、最终状态已经全面验收。对应candidate-module.json/.result.json及candidate-module-review.md。正式稿SHA256：763467916916AEFF88C10C679F944F82C034DC18A52F8931853B3FA12F9B2092。

覆盖率03宿主完成、模型PASS。正式11条用例真实执行136项断言，18项不符（不是18个独立根因）：含无效设置却预期secret_kind=3、清理却预期凭证或completed归零，以及重复准备的返回矛盾。独立审阅确认主要转录忠实；泛称“不变”的部分剩余字段未全部展开，不宣称检查了每条笼统表述。对应candidate-coverage.json/.result.json。正式稿SHA256：586A25B8F0104E25455FAF8FD1572FDB61D1CB7CD25181572B39DB1C814168EA。

真实读取证据另见coverage-producer-read-evidence.json和coverage-reviewer-read-evidence.json。Producer确实读了新增规则，但仍产生错误；Reviewer读了阶段04和冻结源码，没有工具读取新参考文件，却认可了错误。不能把所有问题都归因于文件未加载。

## 内联关键方法的候选

针对Reviewer未继续读取参考规则的已观察遗漏，将关键求值步骤直接放入两套阶段03/04正文，并加入通用提前return、部分reset与随后start的反例；保留契约/实现区分，不增加语义门禁。版本覆盖率1.1.7、模块1.4.5。Companion187、Agent13再次通过，独立审阅未发现例子错误或权限越界。

上一组任务全部结束后同步34个生产文件，重启隔离Desktop（PID128984，Harness子进程145972，实际页面http://127.0.0.1:10573/）。通过实际产品新建任务界面创建：

- analysis-260910-04 / task-20260909171119-65247e：模块1.4.5。
- analysis-260910-05 / task-20260909171145-2f4135：覆盖率1.1.7。

仍使用M2.7-highspeed、深度模式、相同源码与覆盖率文件。已核对冻结版本、四个有效阶段正文中的内联方法和源码哈希，记录在inline-input-evidence.json；同步记录inline-runtime-patch.json。两个Run的冻结源码均已独立编译为外部验收驱动。此次交互对象是实际Desktop启动的Harness产品界面，不是另起开发服务器或原生窗口点击证明。

覆盖率05已完成正式交付及同一Reviewer正式复核，实际产品界面显示已完成/100%/12条用例。正式文稿SHA256：33DD134CE66FABA2A584484D6BE4D6286D2F49880192FC96F6EE029E4BC7234F。12例50个明确断言在记录的外部初态夹具下未发现数值矛盾；原错误“abort恢复completed”被本次真实Reviewer指出并由Producer修正。仍不能判完整质量通过：原文初始化不全、清理有二选一且未给具体末态断言，注释误称认证/连接状态不影响某些目标。TC-COMPLETE-003的中途直接字段赋值被忠实执行，未换成业务调用。对应inline-coverage.json/.result.json；赋值版外部驱动assignment_driver.c只对原文赋值/明确记录的夹具赋值，返回为null，业务调用直接运行冻结C。

读取证据inline-read-evidence.json确认：两套Producer/Reviewer的工具读取结果均包含内联方法，且都读取了冻结源码。这次残留错误不能归因于未加载规则。

模块04已完成正式交付及同一Reviewer正式复核，正式文稿SHA256：9FBDCD20F40E0FF226E75F3BC422D302665A257A6FFF58A9B46875D8DC8491F7。最终15例83个明确断言有3处返回值矛盾：TC03/TC15前置已建连，步骤再次open_plain期待0实际-4；TC08前置pending=1，步骤再次submit_admin期待0实际-4。TC02最终改成直接赋值secret_kind=99，原来通过set_secret99却期待成功的两处错误已消除；外部赋值驱动忠实执行，未为赋值编造成功码。TC01“恢复初始状态”没有明确基准，TC12“手动重置”没有明确字段/值，清理未算通过。对应inline-module.json/.result.json及inline-module-review.md。独立转录审阅和执行后哈希复核完成。

两个任务的completed、host_review complete及最终文稿哈希封存在inline-final-task-evidence.json。模型都给出PASS，但本轮外部验收结论为：**部分改善，仍未全部通过**。覆盖率明确数值断言没有发现矛盾，并不代表所有初态和清理声明完整；模块仍有可重复执行的返回值矛盾。强化Skill及同模型独立复核尚不足以稳定解决问题，不应据此出包宣称质量问题已修复。

## 验收中发现的交付错误反馈遗漏

模块04连续失败时，complete-step/finalize只返回“正式用例缺项”及路径，没有输出已经算出的delivery_integrity具体缺失字段，且中文stdout在模型轨迹中出现乱码。两套源码脚本的失败JSON现补回delivery_feedback，并使用ASCII JSON转义传输。保留原错误、失败状态和退出码2，未放宽校验或代写用例。

新test_delivery_failure_feedback.py用真实不完整正式文件覆盖两套脚本、两个失败命令：4子场景先失败后通过，验证具体Case ID/缺失字段/原文件路径完整返回，JSON可跨Windows编码传输，原文不被自动补写。Agent相关14项回归通过，独立只读审阅通过。此后补错误反馈修复在源码中，未修改正在验收的冻结Skill，因此上述Desktop任务不构成该后补修复的端到端证明。

证据目录：D:/pangea-e2e-targets/desktop-test79-20260909/execution-verification。工具链为官方Zig0.14.1 Windows包，SHA256已按官方目录核验，未加入产品依赖。无提交、推送或出包。
