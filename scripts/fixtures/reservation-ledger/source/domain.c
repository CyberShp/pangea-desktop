#include "ledger.h"
#include <string.h>
int reserve(Ledger *l, const char *id, long amount) {
    if (amount <= 0 || !valid_id(id)) return 2;
    if (!strcmp(l->last_id, id)) return l->last_amount == amount ? 5 : 2;
    if (amount > l->capacity - l->used) return 1;
    l->used += amount;
    l->revision++;
    strcpy(l->last_id, id);
    l->last_amount = amount;
    return 0;
}
int release(Ledger *l, long amount) {
    if (amount <= 0 || amount > l->used) return 2;
    l->used -= amount;
    l->revision++;
    l->last_id[0] = '\0';
    l->last_amount = 0;
    return 0;
}
