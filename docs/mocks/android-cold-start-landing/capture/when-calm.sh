#!/usr/bin/env bash
# Waits for the host's memory pressure to ease (shared-android-emulator-gotchas: full avg10 < 3 keeps the guest out of swap), then exits.
calm=0
for i in $(seq 1 720); do
  full=$(awk -F'[= ]' '/^full/ {print $3}' /proc/pressure/memory)
  if awk -v f="$full" 'BEGIN{exit !(f<3)}'; then calm=$((calm+1)); else calm=0; fi
  [ "$calm" -ge 4 ] && { echo "calm at $(date -u +%T) full=$full load=$(cut -d' ' -f1 /proc/loadavg)"; exit 0; }
  sleep 15
done
echo "still under pressure at $(date -u +%T) full=$full"; exit 1
