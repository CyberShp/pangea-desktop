# 固定容量消息队列设计

本材料为自创验收夹具的契约。配套覆盖率是合成输入，只测试资产消费与补测推导，不代表真实执行。

- MQ-D01：调用者在首次使用前成功调用 mq_init；容量支持 1 到 MQ_MAX。不得直接改写 mq 字段或以损坏、未初始化的对象调用接口。NULL 对象返回 MQ_INVALID，mq_size(NULL) 返回 0。
- MQ-D02：本模块只支持单线程顺序调用，不支持中断重入或并发访问；同步由调用者负责，不要求模块内部加锁。
- MQ-D03：mq_push 的 value 为 int 值，可为 0、负数、INT_MIN 或 INT_MAX。满队列返回 MQ_FULL，保持原内容；成功则尾部插入。
- MQ-D04：mq_pop 与 mq_peek 的 out 为有效 int 指针，NULL 返回 MQ_INVALID。pop 空队列返回 MQ_EMPTY，失败不修改 out。正常出队保持 FIFO 顺序。
- MQ-D05：mq_clear 只需将 head/count 清零，不必擦除 slots。后续 peek/pop 不得暴露已清除消息；不要求安全擦除内存，调用者不得通过直接读取 slots 判断清理结果。
- MQ-D06：mq_peek 合法 offset 范围是 0 <= offset < count；其余返回 MQ_INVALID，失败不修改 out，成功读取指定消息但不改变队列状态。
- MQ-D07：容量 1、环形回绕、重复清空和再次入队属于支持范围，应保持上述语义。

接口返回值及 mq_size、peek/pop 返回的消息是外部观察点。无需从未使用槽位读取数据，也无需检查清空后的物理内存字节。
