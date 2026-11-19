# The welcome card on iPhone and Mac, beside the web

Each board puts the web's shipped page (`../a-*.png`) beside the iPhone and Mac apps in the same state, photographed
by the probe in `docs/evidence/new-user-onboarding-apple/probe-harness` (task 34vVmAY8RjCVUiaWKFD6N, run
https://github.com/jianghailong-xy/orbit/actions/runs/42959647847, all 16 UI tests passing).

| Board | Web page | State |
| --- | --- | --- |
| `managed-preparing.png` | `a-managed.png` | Managed runner preparing: its own notice in step 1, step 2 waits, foot WAIT |
| `managed-model.png` | `a-model.png` | Managed runner up: step 1 done, step 2 signs in |
| `managed-ready.png` | `a-ready.png` | Both done, an example picked into the composer, foot READY |
| `machine.png` | `a-machine.png` | A bare machine's setup card with the welcome head and the examples step |
| `register.png` | `a-register.png` | No machine: the install command; steps 2–3 open after step 1 |
| `history-no-change.png` | — | The same three for an account with a Completed session: no card, pages as before |

The stub's names and data are made up. Composed with `compose.py` and `history.py` from the harness.
