/* Synthetic test service; not an implementation of a real network protocol. */
typedef struct {
    int secret_kind, authenticated, secure, connected, pending, credits, completed;
} Session;
enum { OK = 0, INVALID = -1, AUTH_REQUIRED = -2, NOT_CONNECTED = -3,
       BUSY = -4, NO_COMMAND = -5, PEER_REJECTED = -6 };

int set_secret(Session *s, int kind) {
    if (kind != 1 && kind != 2) return INVALID;
    if (s->connected) return BUSY;
    s->secret_kind = kind;
    return OK;
}

/* The ownership cleanup is shared by plain and secure connections. */
int release_session(Session *s) {
    s->credits = 0;
    s->pending = 0;
    s->connected = 0;
    s->secure = 0;
    return OK;
}

int authenticate(Session *s, int accepted) {
    s->authenticated = accepted != 0;
    if (!accepted && s->secure) release_session(s);
    return accepted ? OK : AUTH_REQUIRED;
}

int open_secure(Session *s, int peer_accepts) {
    if (s->connected) return BUSY;
    if (s->secret_kind != 1 && s->secret_kind != 2) return INVALID;
    if (!s->authenticated) return AUTH_REQUIRED;
    s->credits = 1;
    if (!peer_accepts) {
        release_session(s);
        return PEER_REJECTED;
    }
    s->secure = 1;
    s->connected = 1;
    return OK;
}

int open_plain(Session *s) {
    if (s->connected) return BUSY;
    s->credits = 1;
    s->connected = 1;
    return OK;
}

int submit_admin(Session *s) {
    if (!s->connected) return NOT_CONNECTED;
    if (s->pending) return BUSY;
    s->pending = 1;
    return OK;
}

int complete_admin(Session *s) {
    if (!s->pending) return NO_COMMAND;
    s->pending = 0;
    s->completed++;
    return OK;
}

int abort_admin(Session *s) {
    if (!s->pending) return NO_COMMAND;
    s->pending = 0;
    return OK;
}

int disconnect(Session *s) {
    return release_session(s);
}

int completed_count(Session *s) {
    return s->completed;
}

/* Datagram checksum endpoint: no session state or secure-transport caller. */
int check_datagram(int supplied, int computed) {
    return supplied == computed ? OK : INVALID;
}
