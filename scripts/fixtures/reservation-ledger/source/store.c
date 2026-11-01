#include "ledger.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
int load_ledger(const char *path, Ledger *l) {
    FILE *f = fopen(path, "r");
    if (!f) return errno == ENOENT ? 3 : 4;
    char magic[8], cap[32], used[32], rev[32], amount[32], id[34], extra;
    int n = fscanf(f, "%7s %31s %31s %31s %33s %31s %c", magic, cap, used, rev, id, amount, &extra);
    int failed = ferror(f); fclose(f);
    if (failed || n != 6 || strcmp(magic, "LEDGER1") ||
        !parse_nonnegative(cap, &l->capacity) || !parse_nonnegative(used, &l->used) ||
        !parse_nonnegative(rev, &l->revision) || !parse_nonnegative(amount, &l->last_amount) ||
        l->used > l->capacity || (strcmp(id, "-") && !valid_id(id))) return 4;
    strcpy(l->last_id, !strcmp(id, "-") ? "" : id);
    return 0;
}
int save_ledger(const char *path, const Ledger *l) {
    char tmp[4096];
    if (snprintf(tmp, sizeof(tmp), "%s.tmp.%ld", path, (long)getpid()) >= (int)sizeof(tmp)) return 4;
    FILE *f = fopen(tmp, "w");
    if (!f) return 4;
    int bad = fprintf(f, "LEDGER1 %ld %ld %ld %s %ld\n", l->capacity, l->used,
                      l->revision, l->last_id[0] ? l->last_id : "-", l->last_amount) < 0;
    if (fclose(f)) bad = 1;
    const char *fail = getenv("LEDGER_FAIL_COMMIT");
    if (bad || (fail && !strcmp(fail, "1"))) { remove(tmp); return 4; }
    if (rename(tmp, path)) { remove(tmp); return 4; }
    return 0;
}
