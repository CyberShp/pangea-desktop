#include "ledger.h"
#include <stdio.h>
#include <string.h>
#include <limits.h>
int main(int argc, char **argv) {
    if (argc < 3) { puts("usage: ledger FILE init|status|reserve|release ..."); return 2; }
    const char *file = argv[1], *cmd = argv[2];
    Ledger l = {0}; long amount;
    int rc = load_ledger(file, &l);
    if (!strcmp(cmd, "init")) {
        if (argc != 4 || !parse_nonnegative(argv[3], &amount) || amount == 0) { puts("invalid input"); return 2; }
        if (rc != 3) { puts(rc == 0 ? "already exists" : "store error"); return rc == 0 ? 2 : 4; }
        l.capacity = amount;
        if (save_ledger(file, &l)) { puts("store error"); return 4; }
        puts("initialized"); return 0;
    }
    if (rc) { puts(rc == 3 ? "not initialized" : "store error"); return rc; }
    if (!strcmp(cmd, "status") && argc == 3) {
        printf("capacity=%ld used=%ld remaining=%ld revision=%ld\n", l.capacity, l.used, l.capacity-l.used, l.revision);
        return 0;
    }
    if (l.revision == LONG_MAX) { puts("revision exhausted"); return 2; }
    if (!strcmp(cmd, "reserve") && argc == 5 && parse_nonnegative(argv[4], &amount)) rc = reserve(&l, argv[3], amount);
    else if (!strcmp(cmd, "release") && argc == 4 && parse_nonnegative(argv[3], &amount)) rc = release(&l, amount);
    else rc = 2;
    if (rc == 5) { puts("duplicate"); return 0; }
    if (rc) { puts(rc == 1 ? "denied" : "invalid input"); return rc; }
    if (save_ledger(file, &l)) { puts("store error"); return 4; }
    printf("committed used=%ld revision=%ld\n", l.used, l.revision); return 0;
}
