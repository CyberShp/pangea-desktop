#!/bin/sh
# Entry: sh submit.sh STATE_FILE LABEL LIMIT AMOUNT
if [ "$#" -ne 4 ]; then
    printf '%s\n' 'usage: submit.sh STATE_FILE LABEL LIMIT AMOUNT' >&2
    exit 2
fi
base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 4
state=$1
label=$2
limit=$3
amount=$4
python3 "$base/bridge.py" "$state" $label "$limit" "$amount"
printf '%s\n' 'request finished'
