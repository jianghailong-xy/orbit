#!/usr/bin/env bash
set -euo pipefail

# Provision the Google APIs x86_64 functional-test matrix, without replacing AVDs.
export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-21-openjdk-amd64}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_USER_HOME="${ANDROID_USER_HOME:-/var/lib/orbit/android/user}"
export ANDROID_AVD_HOME="${ANDROID_AVD_HOME:-/var/lib/orbit/android/avd}"
lock_file="${ANDROID_DEVICE_LOCK:-/var/lib/orbit/android/ui.lock}"
sdkmanager="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
avdmanager="$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager"

apis=("$@")
if (( ${#apis[@]} == 0 )); then apis=(29 30 31 32 33 34 35 36); fi
packages=()
for api in "${apis[@]}"; do
  [[ "$api" =~ ^(29|3[0-6])$ ]] || { echo "Expected API 29–36, got: $api" >&2; exit 2; }
  if [[ ! -f "$ANDROID_HOME/system-images/android-$api/google_apis/x86_64/package.xml" ]]; then
    packages+=("system-images;android-$api;google_apis;x86_64")
  fi
done
mkdir -p "$ANDROID_USER_HOME" "$ANDROID_AVD_HOME" "$(dirname "$lock_file")"
exec 9>"$lock_file"
flock -w 600 9
if (( ${#packages[@]} > 0 )); then
  "$sdkmanager" --sdk_root="$ANDROID_HOME" "${packages[@]}"
fi
for api in "${apis[@]}"; do
  avd_name="orbit-ui-api$api"
  if [[ -f "$ANDROID_AVD_HOME/$avd_name.ini" ]]; then
    echo "Preserving existing $avd_name"
  else
    "$avdmanager" create avd --name "$avd_name" \
      --package "system-images;android-$api;google_apis;x86_64" \
      --device pixel_2 --path "$ANDROID_AVD_HOME/$avd_name.avd" <<< no
  fi
  cat "$ANDROID_HOME/system-images/android-$api/google_apis/x86_64/source.properties"
done
"$avdmanager" list avd
