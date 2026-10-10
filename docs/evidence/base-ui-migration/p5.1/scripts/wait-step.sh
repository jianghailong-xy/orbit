#!/usr/bin/env bash
# wait-step.sh LOG: return once a formal step's log records its exit code (formal.sh writes `exit=` last), printing
# the step's totals. For waking the session at a step's end, not for the record.
log=$1
until [ -f "$log" ] && grep -q '^exit=' "$log"; do sleep 15; done
grep -E "^\s+[0-9]+ (passed|failed|flaky|skipped)|^exit=" "$log"
