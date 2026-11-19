# Evidence probe: a new account's welcome card on iPhone and Mac

Task 34vVmAY8RjCVUiaWKFD6N (iOS/macOS parity with the web's welcome card, docs/mocks/new-user-onboarding), copied
from `docs/evidence/first-workspace-finish/probe-harness`. The probe builds the apps' own shells from the real
shared sources into throwaway apps pointed at `stub.py` and photographs each state of the card:

- managed runner's default workspace: preparing (step 1 shows the runner's own notice), up (step 2 signs in),
  ready (signed in; a picked example fills the composer, the foot says All set);
- a bare machine's setup card: the welcome head and the examples step;
- no machine at all: step 1 is the install command, steps 2–3 open after it; a machine coming online moves the
  page on to that machine's card by itself;
- the same three with a Completed session on the account (`{"history": true}`): no welcome card anywhere.

`stub.py` is the fixture API (all data made up; the managed runner's statuses are the shared fixture's);
`POST /__set` picks a scene, `GET /__log` is the request log. `ci/client.probe.yml` is client.yml on a `probe/…`
branch with the macOS and iOS gates beside the shots; it is never merged. To run it again, copy this directory to
`.wlc-probe/` at the repository root and `ci/client.probe.yml` to `.github/workflows/client.yml`.
