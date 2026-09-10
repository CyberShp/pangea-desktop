#ifndef MQ_H
#define MQ_H
#include <stddef.h>
#define MQ_MAX 8
enum { MQ_OK, MQ_INVALID, MQ_FULL, MQ_EMPTY };
typedef struct {
    int slots[MQ_MAX];
    size_t capacity, head, count;
} mq;
int mq_init(mq *q, size_t capacity);
int mq_push(mq *q, int value);
int mq_pop(mq *q, int *out);
int mq_peek(const mq *q, size_t offset, int *out);
int mq_clear(mq *q);
size_t mq_size(const mq *q);
#endif
