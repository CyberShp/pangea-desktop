#ifndef LEDGER_H
#define LEDGER_H
#include <stddef.h>
typedef struct { long capacity, used, revision; char last_id[33]; long last_amount; } Ledger;
int parse_nonnegative(const char *text, long *value);
int valid_id(const char *text);
int load_ledger(const char *path, Ledger *ledger); /* 0 ok, 3 missing, 4 corrupt/io */
int save_ledger(const char *path, const Ledger *ledger); /* 0 ok, 4 io; atomic rename */
int reserve(Ledger *ledger, const char *id, long amount); /* 0 accepted, 1 denied, 2 invalid, 5 duplicate */
int release(Ledger *ledger, long amount);
#endif
