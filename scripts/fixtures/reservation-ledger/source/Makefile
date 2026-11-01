CC ?= cc
CFLAGS ?= -std=c99 -Wall -Wextra -Werror -O0
ledger: main.c parse.c domain.c store.c ledger.h
	$(CC) $(CFLAGS) main.c parse.c domain.c store.c -o ledger
