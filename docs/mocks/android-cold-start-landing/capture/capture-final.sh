#!/usr/bin/env bash
# Both trees: build, then every walk the board uses, and clean launches of the prototype.
S=/mnt/data/android-landing-board; A=app/outputs/apk
$S/kit/build.sh today || exit 1
$S/kit/build.sh proto || exit 1
$S/kit/when-calm.sh
rm -rf $S/shots/today $S/shots/proto
WALKS="firstSignIn foreground offline" $S/kit/run.sh today $S/build-today/out/$A/debug/app-debug.apk $S/build-today/out/$A/androidTest/debug/app-debug-androidTest.apk $S/shots/today
echo "--- today rc=$?"; cut -c1-170 $S/shots/today/result.txt | grep -a -v Invoker
WALKS="firstSignIn savedBar savedLine savedSilent savedCompleted savedDrawer offline failed relaunch foreground" $S/kit/run.sh proto $S/build-proto/out/$A/debug/app-debug.apk $S/build-proto/out/$A/androidTest/debug/app-debug-androidTest.apk $S/shots/proto
echo "--- proto rc=$?"; cut -c1-170 $S/shots/proto/result.txt | grep -a -v Invoker
