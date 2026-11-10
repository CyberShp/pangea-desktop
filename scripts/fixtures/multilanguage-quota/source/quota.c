#include <errno.h>
#include <stdio.h>
#include <stdlib.h>

/* Stateless backend: quota LIMIT USED AMOUNT; stdout is consumed by bridge.py. */
static int number(const char *text, long *value) {
    char *end;
    errno = 0;
    *value = strtol(text, &end, 10);
    return end != text && errno != ERANGE && *value >= 0;
}

int main(int argc, char **argv) {
    long limit, used, amount;
    if (argc != 4 || !number(argv[1], &limit) || !number(argv[2], &used) ||
        !number(argv[3], &amount) || amount == 0 || used > limit) {
        puts("INVALID");
        return 2;
    }
    if (amount > limit - used) {
        printf("DENIED remaining=%ld\n", limit - used);
        return 1;
    }
    printf("ACCEPT remaining=%ld\n", limit - used - amount);
    return 0;
}
