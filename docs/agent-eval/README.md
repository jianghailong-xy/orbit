# Accepted agent-contract eval reports

`baseline.json` is the last black-box report of the agent-contract eval accepted for the supported matrix, and
`baseline.md` its rendering (both written by `scripts/agent-eval.sh live`, see
[`../agent-contract-eval.md`](../agent-contract-eval.md)). The weekly workflow and every run given
`--baseline docs/agent-eval/baseline.json` compare themselves with it cell by cell, and a cell that passed here and
fails there fails the release gate.

A report is accepted by committing it here, in the change that also records what it measured in the supported
matrix (`eval.supportedMatrix` in [`contracts/orbit-agent.contract.json`](../../contracts/orbit-agent.contract.json))
and in the contract's §8.3. A report carries no prompt, reply, argument value, id, path or credential, so it can be
committed as it was written.
