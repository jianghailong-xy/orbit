#!/usr/bin/env bash
# Builds one tree's debug and androidTest APKs with the kit's test: build.sh today|proto
t=$1; S=/mnt/data/android-landing-board
RR_WT=$S/$t RR_BUILD=$S/build-$t/out RR_PROJECT_CACHE=$S/build-$t/project-cache RR_DOT_KOTLIN=$S/build-$t/dot-kotlin RR_MEM_GB=${RR_MEM_GB:-4} \
  /mnt/data/rr34o8/android/g.sh "landing-board-$t" -I $S/kit/kit.gradle :app:assembleDebug :app:assembleDebugAndroidTest
