# Managed-runner lab

The lab's design, names, versions and the older per-task kits are in
[docs/managed-runner-lab.md](../../../docs/managed-runner-lab.md). This file covers the lab
scenarios: scripts that bring the lab up from nothing and check one feature on it, and the GitHub
workflow that runs them.

## Scenarios on GitHub CI

A scenario is a file in [scenarios/](scenarios/), named after what it checks:

| Scenario | What it checks |
| --- | --- |
| `browser_status` | `browser_status` and `orbit browser status` while another session holds the browser |
| `browser_open` | `browser_open` and `orbit browser open --url`: the browser started from stopped, each page loaded in the remote Chrome and shot through the viewer, both absent with `ORBIT_BROWSER` unset |
| `browser_clear_logins` | `browser_clear_logins` called in a session's turn (`FAKE-BCLEAR`): a declined card keeps the profile, a confirmed one deletes it |
| `browser_cli_sign_in` | a command-line sign-in with a localhost callback ([cli-sign-in/](cli-sign-in/)) run in a session's Bash (`FAKE-SH`): its page opens in the runner's Chrome through `$BROWSER` and `xdg-open`, the owner signs in through the viewer after a `browser_request_sign_in` card, the callback reaches the tool, and the tool answers `SIGNED_IN` |
| `browser_cli_sign_in_off` | the same command with the switch off: no `BROWSER`, no opener's `xdg-open`, nothing opened |
| `browser_sign_in_banner` | the sign-in card's Open browser opens the tab in control on the agent's page with the request banner; Done leaves the card open; I'm signed in answers it and the agent's turn carries on; Not now answers NOT_NOW |

[scenarios/run.sh](scenarios/run.sh) does the whole run on one machine, as root:

1. the lab VM (`create.sh`: k3s, Ceph, Ceph-CSI) under KVM;
2. the runner image from the checkout's HEAD with the lab CA on top, imported into k3s and pinned;
3. the test control plane (`test-server.sh`), managed runners on, and the browser switch
   `ORBIT_MANAGED_RUNNER_BROWSER_ENABLED` on unless the scenario file has the line
   `# lab-browser: off`; the runner link gateway and NATS;
4. one owner, `erin`, with a key on the fake model (`fake-model.py`), and their runner READY;
5. the scenario, then the logs collected and the lab stopped.

Each check prints `PASS  <check>` or `FAIL  <check>`. The run ends with one line,
`SCENARIO <name>: PASS` or `SCENARIO <name>: FAIL`, and writes `result.json`
(`{"scenario", "sha", "result", "browserSwitch", "checks": [...]}`) beside the screenshots,
`logs/` and `sessions/` in `LAB_OUT`. It exits 0 only on PASS.

The workflow [.github/workflows/managed-runner-lab.yml](../../../.github/workflows/managed-runner-lab.yml)
runs `run.sh` on `ubuntu-latest`. It has no secrets, since the lab uses the fake model, and a
timeout of 180 minutes. A run takes about an hour, most of it the lab VM's first build.

### Dispatching a scenario for a task

Run a scenario at the commit you want checked, usually the task's probe branch (the project
branch merged in, as for `ci.yml`):

```sh
git push origin HEAD:refs/heads/probe/<name>
gh workflow run managed-runner-lab.yml --ref probe/<name> -f scenario=<scenario>
# The run just started on that branch:
gh run list --workflow managed-runner-lab.yml --branch probe/<name> --limit 1 \
  --json databaseId,headSha,url,status
```

A new scenario is a new file in `scenarios/` on the probe branch: the workflow runs the scenario
from the dispatched ref, so it needs no change on `main` first.

### Citing a run

Cite the run through a `bg_run` job that waits for it and exits with its result:

```sh
gh run watch <run id> --exit-status --interval 60 > /dev/null; rc=$?
gh run view <run id> --json url,headSha,conclusion
exit $rc
```

In the claim, name the run's URL, its `headSha` and the scenario. The artifact
`managed-runner-lab-<scenario>` holds `result.json`, `run.log`, the screenshots and `logs/`
(apiserver, link gateway, runner container, fake model, VM console). Fetch it with
`gh run download <run id> -n managed-runner-lab-<scenario> -D <dir>`.

### Writing a scenario

A scenario is a Bash fragment that `run.sh` sources once the lab is up, so it sees the helpers
and variables of [scenarios/common.sh](scenarios/common.sh): `check NAME COMMAND...`,
`check_eq NAME ACTUAL EXPECTED`, `abort NAME`, `session` (a session on erin's runner, waited
for), `last_tool_result TOOL`, `in_pod`, `cdp_pages`, `mcp_has`/`mcp_lacks`, `owner_get`,
`browser_state`, `serve_pages`, `serve_web`, and `$OUT`, `$RUNNER`, `$POD`, `$SLUG`. Write
screenshots and outputs to `$OUT`. Name no host path: everything is found from the checkout and
`lab.env`.

### On HPC

`run.sh` builds a fresh lab and expects `LAB_DIR` (in `lab.env`) to be empty or its own. The
HPC browser lab keeps its own state and scripts; leave it as it is.
