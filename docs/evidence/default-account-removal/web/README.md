# Web: Remove Default, its removed state and Use again

Task 34jpFWMMTBMQu7Ceyp6zk of project 34jjcdca6uuW0qHCjTdKg ("Remove a runner's Default account from
Orbit"). Frames of a runner's card on the Providers page (`/infrastructure`, where `/providers` lands),
from the production build: real routes, components and CSS. Only the REST data is synthetic —
`src/web/ui-migration/fixtures.mjs` plus a runner served the way the control plane serves it with Codex's
Default removed (`usedRunnerEngines`: the remaining accounts, `removedDefault`, the engine's sign-in and
quota theirs). The clock is the fixtures' frozen 2026-09-28 12:00Z, shown in Asia/Shanghai.

| Frame | What it shows |
| --- | --- |
| `screenshots/removed-two-light.png` | Default removed, Work and Personal remaining: each with its own sign-in and quota, NEXT on Work, the head counting only them, and the group ending with "Default · ~/.codex isn’t used by Orbit" and Use again |
| `screenshots/removed-one-light.png` | One account remaining: still a group, never the engine's own row |
| `screenshots/removed-one-dark.png` | The same, dark |
| `screenshots/removed-two-phone.png` | Two remaining, at 390 px |
| `screenshots/confirm-remove-default-light.png` | Before removal: Default's ⋯ → Remove account asks "Remove Default?" |

`capture-results.json` holds what each frame read off the page (the head's count, the account names,
the removed line, the question) and the API calls no fixture answered (none).

To take them again:

```sh
bash scripts/worktree-overlay.sh
(cd src/web && npx vite build --outDir /var/tmp/w-default-shots/dist --emptyOutDir)
FONTCONFIG_FILE=/mnt/data/pe-mock/fonts.conf unshare -n bash -c \
  'ip link set lo up && node docs/evidence/default-account-removal/web/capture.mjs /var/tmp/w-default-shots/dist'
```

The copy every client says is in `src/web/src/lib/runnerAccountCopy.ts`.
