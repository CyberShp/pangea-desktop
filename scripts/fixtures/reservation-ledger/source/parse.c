#include "ledger.h"
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
int parse_nonnegative(const char *text, long *value) {
    char *end; errno = 0;
    if (!text || !*text) return 0;
    for (const unsigned char *p = (const unsigned char *)text; *p; ++p)
        if (!isdigit(*p)) return 0;
    *value = strtol(text, &end, 10);
    return errno != ERANGE && !*end && *value >= 0;
}
int valid_id(const char *text) {
    size_t n = strlen(text);
    if (!n || n > 32) return 0;
    for (size_t i = 0; i < n; ++i)
        if (!isalnum((unsigned char)text[i]) && text[i] != '-' && text[i] != '_') return 0;
    return 1;
}
