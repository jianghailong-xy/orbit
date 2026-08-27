# HUMAN_ONLY authority and credential trust

This document defines what Orbit's three project-level `HUMAN_ONLY` actions guarantee:

- edit project acceptance criteria;
- record a `PASS` conclusion;
- settle a project as `DONE`.

It is deliberately limited to those actions. It does not redesign authentication.

## Decision

`authorityPrincipal(undefined)` must **not** become a blanket refusal. A missing acting Session is
used by the owner REST API, headless CLI calls, and trusted internal callers. Treating every such
call as unauthorized would turn a role restriction into a new authentication requirement and
would break those paths.

The old return value was nevertheless misleading: it called every non-judgment request `USER`.
The implementation now calls it `NON_JUDGMENT`. This is a negative statement — the request is not
attributable to the one-shot `PROJECT_COORDINATOR` judgment role — and not a claim that Orbit
proved a person was present. The behavior is unchanged:

```text
dispatch_origin = PROJECT_COORDINATOR  -> JUDGMENT
any other origin, null, or undefined   -> NON_JUDGMENT
```

`HUMAN_ONLY` remains the stable policy and refusal-tier name. It means "route this decision to
owner review and retain the action-specific evidence described below." It does not mean "an agent
is technically unable to perform this action," and it does not promise that every action stores a
requester identity.

## Current path matrix

The distinction is intentionally about route and role, not biological identity. Current behavior
must be read per authenticated door:

| Request path | No acting Session | Acceptance criteria | Task verdict `PASS` | Project acceptance `PASS` | Project `DONE` |
| --- | --- | --- | --- | --- | --- |
| Owner REST API with a user JWT | `NON_JUDGMENT` | allowed | allowed | allowed | allowed |
| Headless CLI/MCP with the runner credential | no judgment role | allowed | allowed | refused because that endpoint separately retains machine attribution | allowed |
| One-shot judgment Session | `JUDGMENT` | refused | refused | refused | refused |
| Trusted direct/internal caller with no Session | `NON_JUDGMENT` | allowed | allowed | allowed unless it explicitly supplies machine attribution | allowed |
| Borrowed or minted owner JWT | indistinguishable from the owner REST row | allowed | allowed | allowed | allowed |

There is currently no production cron job that writes these three facts. The no-Session service
default remains available for trusted internal/cron composition; adding such a writer must still
document its authority and the traceability fields it persists.

The PASS row also has two service surfaces. Project acceptance records criterion conclusions;
task verification records a task verdict. Both refuse a known judgment Session. The project
acceptance runner endpoint additionally supplies a fallback machine id when the acting Session
header is absent, which is why a headless runner cannot record PASS there while it can still record
`FAIL` or `INCONCLUSIVE`.

Tests lock this matrix in `coordinator-authority-boundary.spec.ts`:

- `an agent-held runner credential with no acting session can edit acceptanceCriteria`;
- `an agent-held runner credential with no acting session can write task verdict=PASS`;
- `an agent-held runner credential with no acting session cannot record acceptance PASS`;
- `an agent-held runner credential with no acting session can write project.status=DONE`;
- `a headless runner can still record a conservative acceptance conclusion`;
- the generated `a no-session owner/internal caller ...` controls for project updates and PASS;
- the three `an owner JWT minted with the shared secret ...` cases for the owner REST API.

## Why credentials cannot prove "human" in a co-located deployment

The user access token is a bearer JWT signed with `JWT_SECRET`. `JwtAuthGuard` verifies the
signature and then accepts the token's `sub` as the user id. It has no independently signed
human-presence claim, issuance ledger, hardware key assertion, or action-bound challenge.

If an agent can read `JWT_SECRET`, execute code inside the apiserver container, or otherwise ask
the same signing authority to sign an arbitrary owner subject, it can mint a token whose verified
claims are identical to a token returned by owner login. Borrowing an existing owner token has the
same result. The server cannot infer which holder sent the request after verification.

N20 demonstrated this in the deployed system on 2026-08-27: a one-hour owner JWT was minted inside
the running apiserver and used in a browser to submit eleven project-acceptance conclusions. The
stored actor was `USER` and the recorded id was the account owner. N21's unit test models the same
trust condition with the real `JwtService` and `JwtAuthGuard`, without reading or printing any
deployment secret or token.

Short token lifetimes, a distinct HTTP route, a hidden button, or a second click do not repair this
assumption. A principal that can mint the token can mint a fresh short-lived token and call the
same route. A symmetric JWT also provides no human non-repudiation: the verifier and every party
with the shared signing secret can create the same signature.

## What HUMAN_ONLY actually provides

In a deployment where agents cannot obtain owner credentials, the rules are a useful least-
privilege boundary. In the co-located/shared-secret deployment described above, they still provide:

1. **Judgment-role separation.** The ordinary one-shot judgment Session cannot rewrite its exam,
   declare PASS, or settle the project through its attributed path. This prevents accidental
   self-grading and makes the expected escalation explicit.
2. **Action-specific traceability, not one uniform actor audit.** The current records are:
   - an acceptance-criteria edit freezes the resulting criteria, revision/digest, evidence version,
     and time in an acceptance run; that run says `decidedBy=USER` for this path but stores no
     requester id, and a headless runner can produce the same label;
   - a task-verification verdict stores the verdict, monotonic verdict revision, and task update
     time. An evidence-bound judgment request also stores a credentialed decision actor, but legacy
     verification tasks do not have one uniform requester-identity event;
   - a project-acceptance conclusion is append-only and records `decidedBy`, `decidedById`, acting
     Session id, decision time, evidence version, and submitted evidence. This is credential/channel
     attribution, and a minted owner JWT produces the same `USER`/owner-id record as owner login;
   - `DONE` records a `done_bound` audit row with the accepted run, criteria digest, and time. It
     does not store the requester identity.
   These records let reviewers reconstruct the standards, evidence, and settlement binding. Only
   the conclusion event answers which credentialed principal submitted the decision.
3. **Tenancy and scope enforcement.** A valid credential remains limited to its account and the
   service's scope contract.

It does **not** provide:

- proof that a human was present or personally reviewed the evidence;
- impossibility of an agent performing the action;
- cryptographic non-repudiation by a human;
- protection against an agent with host/root/container access, a borrowed bearer token, database
  write access, or the owner-token signing secret.

Where an actor is stored, it is attributable to a credentialed channel, not incontrovertibly to a
person. Criteria and DONE currently retain fact/binding evidence rather than an actor. Both forms
of traceability are valuable, but prompts, refusals, API help, and operator documentation must name
the difference.

## Stronger options and their costs

### Separate credential and key domains

Issue owner-interactive tokens with a distinct audience and signing key; runner/service tokens
must never be accepted on those routes. Keep the owner signing key outside the runner host and
outside any container or control surface the agent can access.

This prevents accidental cross-channel use and makes logs clearer. It does not establish human
presence if the agent can still reach the owner key, browser profile, or token issuer. It requires
key rotation, client migration, audience enforcement, recovery procedures, and mixed-version tests.

### Explicit step-up authentication bound to the action

Require a recent WebAuthn/passkey assertion or an identity-provider claim such as an appropriate
`amr`, then bind the challenge to the exact action, project id, acceptance-definition digest, and
expiry. Store that assertion beside the decision.

This is the smallest design that can add a meaningful human-authentication fact. It adds UI
friction, challenge state, replay protection, authenticator enrollment/recovery, accessibility
work, and failure handling. A password re-entry performed with credentials available to the agent
is only another bearer secret, not the same guarantee.

### Out-of-band approval or external signing

Send the action digest to an approval service or hardware-backed signer on a device the agent
cannot control. The apiserver accepts only a signature over that digest and records it with the
decision.

This can approach a hard boundary, but it adds a second trust domain, device availability,
delivery/retry semantics, key recovery, and an operational dependency on the approval service.

### Process and host isolation

Whichever credential scheme is chosen, a hard boundary requires removing the premise that the
agent can read apiserver secrets or control its container. Run agents under a separate OS identity
or host, do not expose the Docker socket or apiserver environment, use a secret manager with a
sign-only policy, and restrict database access. Without this isolation, credential refinements are
primarily defense in depth.

## Consequence for N22

Under the current deployment assumptions, N22 can guarantee that an **owner-attributed channel**
confirmed one exact digest only if its new record explicitly retains the digest, credentialed actor
id, and time. Even with those fields, it cannot guarantee that a human personally performed the
confirmation.

If N22 only needs workflow separation and audit visibility, it should bind the confirmation to the
standard-set digest and use the existing owner-channel model while stating this limitation. If it
needs a hard human guarantee, its confirmation must require one of the isolated, action-bound
step-up or external-signature designs above; another ordinary JWT or second click is insufficient.
