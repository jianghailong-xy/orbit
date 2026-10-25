#!/bin/sh
# The two agy binaries on the runner, read without changing either: their versions (auto-update off,
# a throwaway HOME, so --version neither writes a HOME nor starts an updater, contract §13), their
# full sha512, and the run_command fields 1.4.3 still carries in its Go structs but leaves out of
# the schema it declares. Writes results/agy-binary.txt; every command is echoed before its output.
set -eu
NEW=/root/.local/bin/agy
OLD=/root/.local/bin/agy.1792471599648467836.old
cd "$(dirname "$0")"
{
  echo "\$ env -i PATH=/usr/bin:/bin HOME=\$(mktemp -d) AGY_CLI_DISABLE_AUTO_UPDATE=true $NEW --version"
  env -i PATH=/usr/bin:/bin HOME="$(mktemp -d)" AGY_CLI_DISABLE_AUTO_UPDATE=true "$NEW" --version
  echo "\$ env -i PATH=/usr/bin:/bin HOME=\$(mktemp -d) AGY_CLI_DISABLE_AUTO_UPDATE=true $OLD --version"
  env -i PATH=/usr/bin:/bin HOME="$(mktemp -d)" AGY_CLI_DISABLE_AUTO_UPDATE=true "$OLD" --version
  echo "\$ sha512sum $NEW $OLD"
  sha512sum "$NEW" "$OLD"
  echo "\$ strings -n 6 $NEW | grep -oE 'RunPersistent[^[:space:]]*( jsonschema:\"[^\"]*\")?|json:\"RequestedTerminalID\"( jsonschema:\"[^\"]*\")?' | sort | uniq -c"
  strings -n 6 "$NEW" | grep -oE 'RunPersistent[^[:space:]]*( jsonschema:"[^"]*")?|json:"RequestedTerminalID"( jsonschema:"[^"]*")?' | sort | uniq -c
} > results/agy-binary.txt
