# 合成服务外部接口

此服务仅用于分析 Skill 试用，不表示真实协议或产品实现。当前样例没有运行中的服务，设计用例不可声称已执行。

测试客户端 `labctl` 的命令映射如下。所有 session 命令操作同一个已创建的会话。`session new` 创建各字段为零的新会话；`session delete` 删除它。对象指针由服务接线提供，不接受网络传入指针。

| 外部命令 | 源码入口 |
|---|---|
| secret set --kind N | set_secret |
| auth --accept / --reject | authenticate |
| secure open --peer accept / reject | open_secure |
| plain open | open_plain |
| admin submit | submit_admin |
| peer complete | complete_admin |
| admin abort | abort_admin |
| disconnect | disconnect |
| stats completed | completed_count |
| datagram check --supplied N --computed M | check_datagram |

`session show` 是测试接口，直接返回 secret_kind/authenticated/secure/connected/pending/credits/completed，各字段只是观察结果，不提供直接修改命令。响应码使用源码的枚举；协议抓包与客户端响应可独立观察连接和命令结果。

所有操作在单线程事件循环中顺序执行。命令完成由可控对端触发。peer accept/reject 表示测试对端行为。资源 credits 由服务管理，不可直接注入变量。
对端可以在已建立的会话上重新认证。业务是否被认证状态变化影响，以源码为准。测试人员可重复新建/删除会话。

用户需要分析 SecureLink 安全传输的补测。提供的函数报告来自整个服务，同一源文件包含不同接口。源码与报告来自本夹具同一版本。
