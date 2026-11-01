# Wiki System model: the opt-in thinking switch

Task 34q5GS4qKNliE7wQoDkep, 2026-11-01. `ORBIT_WIKI_MODEL_THINKING`, read by the wiki-worker only:

- `disabled` or `enabled`: every call's body ends with `"thinking":{"type":"<value>"}`.
- Unset, empty or blank: no `thinking` field. The body is byte for byte the one the worker sent before the switch.
- Anything else, `Disabled` and `off` included: logged once as a problem, and no `thinking` field is sent.

No real model was called. Every endpoint in these files is a stub on 127.0.0.1, and api.deepseek.com was not
contacted. Verifying DeepSeek with a real key is the owner's, after deployment.

| File | What it shows |
| --- | --- |
| [body-before.txt](body-before.txt) | The bodies the client sent before the switch, from the build of 12117d15a (the commit this branch starts from), captured by `capture-body.cjs` for each value. All are one sha256: that code reads no such variable. |
| [body-after.txt](body-after.txt) | The same capture from the build with the switch. Unset, empty, blank, `Disabled` and `off` give the bytes of `body-before.txt`, the same sha256. `disabled` and `enabled` append the field. A value it cannot use prints the problem `readWikiSystemModel` reports. |
| [apiserver-specs.txt](apiserver-specs.txt) | Every apiserver unit spec (`npm test`), then TAP of `wiki-system-model.spec`, `wiki-model-client.spec` and `wiki-compose-env.spec`. |
| [pg-wiki-model-queue.txt](pg-wiki-model-queue.txt) | The request queue against a real PostgreSQL and a stub model (`scripts/run-pg-spec.sh`). Case 8 runs `WikiModelRequestQueue` with each setting and pins the body the stub received: the wiki-worker's own path from the environment to the wire. |
| [shared-specs.txt](shared-specs.txt) | `wikiContract.spec.ts`, which holds the shared constants to `contracts/wiki.contract.json`, and the whole shared suite. |
| [compose-topology.txt](compose-topology.txt) | Both topology suites: test (l) pins the new line and counts five variables, and a new counterexample gives the switch to the apiserver. Then `docker compose config --quiet`, and each service's System model variables as Compose renders them. |
| [docs-and-copy.txt](docs-and-copy.txt) | `npm run docs:check` and the web copy-language guard. |
| [mutation-checks.txt](mutation-checks.txt) | Each new test turned red by a mutant of the code it covers. |
| [capture-body.cjs](capture-body.cjs), [run.sh](run.sh) | The capture, and the script that re-runs everything above except `body-before.txt` and the mutants. |
