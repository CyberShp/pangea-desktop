#include "mq.h"
#include <assert.h>
#include <limits.h>
#include <stdio.h>

int main(void)
{
    int boundary_failures = 0;
    for (size_t cap = 1; cap <= MQ_MAX; cap++) {
        mq q = {0};
        assert(mq_init(&q, cap) == MQ_OK);
        for (int cycle = 0; cycle < 30; cycle++) {
            for (size_t n = 0; n < cap; n++) assert(mq_push(&q, (int)n + cycle) == MQ_OK);
            assert(mq_push(&q, 0) == MQ_FULL);
            int out = 999;
            if (mq_peek(&q, cap, &out) != MQ_INVALID || out != 999) boundary_failures++;
            for (size_t n = 0; n < cap; n++) {
                assert(mq_peek(&q, 0, &out) == MQ_OK && out == (int)n + cycle);
                assert(mq_pop(&q, &out) == MQ_OK && out == (int)n + cycle);
            }
            assert(mq_push(&q, INT_MIN) == MQ_OK);
            assert(mq_pop(&q, &out) == MQ_OK && out == INT_MIN);
            assert(mq_push(&q, INT_MAX) == MQ_OK);
            assert(mq_clear(&q) == MQ_OK);
            assert(mq_size(&q) == 0);
            out = 999;
            assert(mq_pop(&q, &out) == MQ_EMPTY && out == 999);
            if (mq_peek(&q, 0, &out) != MQ_INVALID || out != 999) boundary_failures++;
            assert(mq_pop(&q, NULL) == MQ_INVALID);
            assert(mq_peek(&q, 0, NULL) == MQ_INVALID);
        }
    }
    printf("boundary_failures=%d\n", boundary_failures);
    return boundary_failures ? 1 : 0;
}
