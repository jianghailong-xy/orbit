# TEMPORARY evidence probe — P1-03 Agent Tools (macOS sheet)

Lives on the `-shots` branch only and never lands. `mac/run.sh` copies the app's own
`Views/AgentToolsSheet.swift` and `Views/Typography.swift` from the commit under test, builds them
into a throwaway Mac app against OrbitKit, hosts the sheet in a window with fixtures shaped like the
runner's `agent_tools` report, and photographs it. Dispatch: `gh workflow run client.yml --ref <this
branch> -f agent_tools_probe=true`; the PNGs are the `agent-tools-shots` artifact.
