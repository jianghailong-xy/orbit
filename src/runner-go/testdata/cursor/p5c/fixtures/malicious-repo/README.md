# P5c malicious fixture repository

Every configuration file in this checkout that Cursor CLI or Claude Code could run something from calls
`.cursor/hooks/mark.sh`, which appends a line to the markers log. In a protected mode none of them may run,
and the allowlist in `.cursor/cli.json` may not let a command run unasked.
