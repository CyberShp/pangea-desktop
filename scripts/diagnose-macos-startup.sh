#!/bin/sh
# Read-only first-launch evidence. Does not remove quarantine, re-sign, authorize,
# install dependencies, open a user profile, or declare business acceptance.
set -u

if [ "$(/usr/bin/uname -s)" != Darwin ]; then
  printf '%s\n' 'This diagnostic must run on the affected Mac.' >&2
  exit 2
fi
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  printf '%s\n' 'Usage: sh diagnose-macos-startup.sh /path/to/PANGEA.app [output-parent]' >&2
  exit 2
fi
app=$(cd "$1" && pwd -P) || exit 2
case "$app" in *.app) ;; *) printf '%s\n' 'Expected an existing .app directory.' >&2; exit 2 ;; esac
output_parent=${2:-$(cd "$(dirname "$0")" && pwd -P)}
output_parent=$(cd "$output_parent" && pwd -P) || exit 2
case "$output_parent/" in "$app/"*) printf '%s\n' 'Diagnostics must be outside the application bundle.' >&2; exit 2 ;; esac
evidence=$(/usr/bin/mktemp -d "$output_parent/pangea-macos-startup.XXXXXX") || exit 2
resources="$app/Contents/Resources"
node="$resources/app/node_modules/node/bin/node"
python="$resources/pangea-python/bin/python3"
probe_pid=
observer_pid=
collection_error=0
# Reap only after the owned PID has disappeared. A process stuck in the kernel
# must not turn a diagnostic timeout into an unbounded shell wait.
finish_child() {
  cleanup_pid=$1
  cleanup_state=complete
  termination_signal=none
  child_status=not_reaped
  if kill -0 "$cleanup_pid" 2>/dev/null; then
    kill -TERM "$cleanup_pid" 2>/dev/null || :
    termination_signal=TERM
    /bin/sleep 1
  fi
  if kill -0 "$cleanup_pid" 2>/dev/null; then
    kill -KILL "$cleanup_pid" 2>/dev/null || :
    termination_signal=KILL
    cleanup_attempt=0
    while kill -0 "$cleanup_pid" 2>/dev/null && [ "$cleanup_attempt" -lt 3 ]; do
      /bin/sleep 1
      cleanup_attempt=$((cleanup_attempt + 1))
    done
  fi
  if kill -0 "$cleanup_pid" 2>/dev/null; then
    cleanup_state=incomplete
    collection_error=1
    printf '%s\n' "$cleanup_pid" >> "$evidence/cleanup-incomplete-pids.txt"
    return
  fi
  wait "$cleanup_pid" 2>/dev/null
  child_status=$?
}
record_check() {
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$child_status" "$3" "$4" "$cleanup_state" "$termination_signal" >> "$evidence/checks.tsv"
}
interrupted() {
  trap '' INT TERM HUP
  if [ -n "$observer_pid" ]; then
    finish_child "$observer_pid"
    record_check "$observer_label" "$observer_pid" interrupted "$(($(/bin/date +%s) - observer_start))"
  fi
  if [ -n "$probe_pid" ]; then
    finish_child "$probe_pid"
    record_check "$label" "$probe_pid" interrupted "$(($(/bin/date +%s) - start))"
  fi
  printf '\nDiagnostic interrupted. Evidence: %s\n' "$evidence" >&2
  exit 130
}
trap interrupted INT TERM HUP
printf 'check\tpid\texit_code\ttimed_out\telapsed_seconds\tcleanup\ttermination_signal\n' > "$evidence/checks.tsv"
printf 'app=%s\nstarted_at=%s\ndownload_first_launch=not_verified\ncausal_diagnosis=not_established\n' "$app" "$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$evidence/context.txt"

# Diagnostic observers have their own deadline and owned PID, including sample's
# attach phase; its sampling-duration argument alone is not a wall-clock limit.
observe() {
  observer_label=$1
  observer_limit=$2
  shift 2
  observer_start=$(/bin/date +%s)
  observer_timeout=false
  "$@" > "$evidence/$observer_label.stdout.log" 2> "$evidence/$observer_label.stderr.log" &
  observer_pid=$!
  while kill -0 "$observer_pid" 2>/dev/null; do
    if [ $(($(/bin/date +%s) - observer_start)) -ge "$observer_limit" ]; then
      observer_timeout=true
      break
    fi
    /bin/sleep 1
  done
  finish_child "$observer_pid"
  record_check "$observer_label" "$observer_pid" "$observer_timeout" "$(($(/bin/date +%s) - observer_start))"
  observer_pid=
}

probe() {
  label=$1
  limit=$2
  shift 2
  start=$(/bin/date +%s)
  timed_out=false
  "$@" > "$evidence/$label.stdout.log" 2> "$evidence/$label.stderr.log" &
  probe_pid=$!
  saved_pid=$probe_pid
  while kill -0 "$probe_pid" 2>/dev/null; do
    now=$(/bin/date +%s)
    if [ $((now - start)) -ge "$limit" ]; then
      timed_out=true
      observe "$label-process" 3 /bin/ps -p "$probe_pid" -o pid=,ppid=,stat=,etime=,command=
      # Sample only the diagnostic's own Node process, before terminating it.
      if [ "$label" = node-runtime ]; then
        observe "$label-sample" 5 /usr/bin/sample "$probe_pid" 1 1 -file "$evidence/$label.sample.txt"
      fi
      break
    fi
    /bin/sleep 1
  done
  finish_child "$probe_pid"
  end=$(/bin/date +%s)
  elapsed=$((end - start))
  record_check "$label" "$saved_pid" "$timed_out" "$elapsed"
  probe_pid=
  printf '%s: exit=%s timeout=%s cleanup=%s\n' "$label" "$child_status" "$timed_out" "$cleanup_state"
}

probe os-version 10 /usr/bin/sw_vers
probe architecture 10 /usr/bin/uname -m
probe bundle-signature 45 /usr/bin/codesign --verify --deep --strict --verbose=2 "$app"
probe bundle-identity 15 /usr/bin/codesign -d --verbose=4 "$app"
probe app-quarantine 10 /usr/bin/xattr -p com.apple.quarantine "$app"
probe node-quarantine 10 /usr/bin/xattr -p com.apple.quarantine "$node"
probe python-quarantine 10 /usr/bin/xattr -p com.apple.quarantine "$python"
probe system-assessment 45 /usr/sbin/spctl --assess --type execute --verbose=4 "$app"
probe node-signature 15 /usr/bin/codesign --verify --strict --verbose=2 "$node"
# Use a new empty HOME; no shell startup, Node injection, credentials or profiles.
/bin/mkdir "$evidence/home" "$evidence/tmp"
probe node-runtime 30 /usr/bin/env -i HOME="$evidence/home" CFFIXED_USER_HOME="$evidence/home" TMPDIR="$evidence/tmp/" PATH=/usr/bin:/bin:/usr/sbin:/sbin LANG=en_US.UTF-8 "$node" -e 'console.log(JSON.stringify({platform:process.platform,arch:process.arch,version:process.version,execPath:process.execPath}))'
printf '\nEvidence: %s\n' "$evidence"
printf '%s\n' 'Diagnostic collection finished. Individual failures remain in checks.tsv.' 'A signature check, Gatekeeper assessment, Node probe and Finder first launch are separate observations.' 'This script did not authorize the application or change macOS security settings.'
exit "$collection_error"
