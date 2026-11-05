#!/usr/bin/env bash
# Prototype's APKs with the shared Gradle home; build dirs on /mnt/data.
S=/mnt/data/tmp/34sMy8
RR_MEM_GB=${RR_MEM_GB:-3} RR_WT=$S/proto RR_BUILD=$S/build-proto/out RR_PROJECT_CACHE=$S/build-proto/project-cache RR_DOT_KOTLIN=$S/build-proto/dot-kotlin \
  /mnt/data/rr34o8/android/g.sh row-swipe-proto "$@"
