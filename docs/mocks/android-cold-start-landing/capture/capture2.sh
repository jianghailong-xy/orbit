#!/usr/bin/env bash
# The iOS-aligned prototype: build, then its walks, then a clean launch of it.
S=/mnt/data/android-landing-board; A=app/outputs/apk; export LANDING_KIT_SRC=$S/kit/src2
RR_WT=$S/proto2 RR_BUILD=$S/build-proto2/out RR_PROJECT_CACHE=$S/build-proto2/project-cache RR_DOT_KOTLIN=$S/build-proto2/dot-kotlin RR_MEM_GB=${RR_MEM_GB:-4} \
  /mnt/data/rr34o8/android/g.sh landing-board-proto2 -I $S/kit/kit.gradle :app:assembleDebug :app:assembleDebugAndroidTest || exit 1
$S/kit/when-calm.sh
rm -rf $S/shots/proto2 $S/shots/proto2-empty
NO_COLD=1 WALKS="emptyFailed" $S/kit/run.sh proto $S/build-proto2/out/$A/debug/app-debug.apk $S/build-proto2/out/$A/androidTest/debug/app-debug-androidTest.apk $S/shots/proto2-empty
WALKS="${WALKS2:-firstSignIn savedPage savedMenu savedLongPress savedDraft offline relaunch completed}" $S/kit/run.sh proto $S/build-proto2/out/$A/debug/app-debug.apk $S/build-proto2/out/$A/androidTest/debug/app-debug-androidTest.apk $S/shots/proto2
echo "--- proto2 rc=$?"; cut -c1-170 $S/shots/proto2/result.txt | grep -a -v Invoker; cut -c1-120 $S/shots/proto2-empty/result.txt | grep -a -E ': OK|FAIL|crash|stopped'
