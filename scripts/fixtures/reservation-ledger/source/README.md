# Reservation ledger CLI

Build with `make`. All commands use a caller-selected state-file path:

- `./ledger FILE init CAPACITY`: create a missing store; existing stores must not be overwritten.
- `./ledger FILE reserve REQUEST_ID AMOUNT`: persist a reservation if capacity permits. Retry of the most recent successful reserve with identical ID and amount returns duplicate without a new write. Different amount for that same ID is invalid. This is only last-request deduplication, not an unlimited request history.
- `./ledger FILE release AMOUNT`: return used capacity and clear the last-request retry marker.
- `./ledger FILE status`: inspect state from a fresh process.

Numeric arguments contain ASCII decimal digits only. IDs contain 1–32 alphanumeric, dash or underscore characters. Return codes: 0 success/duplicate, 1 capacity denial, 2 invalid command/input, 3 missing store, 4 corrupt store or I/O failure. Actual command precedence is defined by source.

Persistence uses a same-directory temporary file and rename. `LEDGER_FAIL_COMMIT=1` is a supported diagnostic mode that simulates failure before rename; it must preserve the old state and remove its temporary file. Clear the environment variable and retry to recover. It is not a concurrency lock or power-loss durability guarantee. The tool supports one writer at a time; parallel writers are outside its supported usage. Tests must use separate temporary stores and never touch a user's file.

Review normal admission, denial, invalid values, duplicate retries and mismatched retries, release and subsequent reuse, initialization protection, missing/corrupt files, commit failure/retry, revision exhaustion, numeric limits, and cross-process persistence. Do not infer guarantees that source does not implement.
