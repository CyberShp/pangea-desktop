#include "mq.h"

int mq_init(mq *q, size_t capacity)
{
    if (!q || capacity == 0 || capacity > MQ_MAX) return MQ_INVALID;
    q->capacity = capacity;
    q->head = 0;
    q->count = 0;
    return MQ_OK;
}

int mq_push(mq *q, int value)
{
    if (!q) return MQ_INVALID;
    if (q->count == q->capacity) return MQ_FULL;
    q->slots[(q->head + q->count) % q->capacity] = value;
    q->count++;
    return MQ_OK;
}

int mq_pop(mq *q, int *out)
{
    if (!q || !out) return MQ_INVALID;
    if (q->count == 0) return MQ_EMPTY;
    *out = q->slots[q->head];
    q->head = (q->head + 1) % q->capacity;
    q->count--;
    return MQ_OK;
}

int mq_peek(const mq *q, size_t offset, int *out)
{
    if (!q || !out) return MQ_INVALID;
    if (offset > q->count) return MQ_INVALID;
    *out = q->slots[(q->head + offset) % q->capacity];
    return MQ_OK;
}

int mq_clear(mq *q)
{
    if (!q) return MQ_INVALID;
    q->head = 0;
    q->count = 0;
    return MQ_OK;
}

size_t mq_size(const mq *q)
{
    return q ? q->count : 0;
}
