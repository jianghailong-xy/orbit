# HUMAN_ONLY authority and credential trust

This document defines what Orbit's project-level `HUMAN_ONLY` actions guarantee:

- edit project acceptance criteria;
- confirm that the complete project acceptance standard set expresses the goal.

Both remaining rows are about the RULER. Recording a `PASS` conclusion was the third, and N26
removed it: `CONCLUDE_VERDICT_PASS` is `COORDINATOR_BOUNDED`, because reading a stated standard
against a frozen evidence version is what an evaluator does, and the account owner accepted that a
machine may do it. What bounds it is unchanged — the conclusion names the immutable evidence
version it judged, every stated criterion must be answered in the same call, and the project-level
verdict is derived from that conjunction rather than supplied.

Project `DONE` is not a `HUMAN_ONLY` write, and since 2026-09-08 it is not, in the ordinary case,
anybody's write at all: `projects/project-done-derived.ts` PROJECTS the column from a standing
confirmation of today's standard set and criteria that are every one satisfied and landed,
recomputing it on two edges that have no requester. A projection is not a gate — it refuses
nothing, and none of what migration `0229_project_acceptance_judgment_removal` took away on
2026-09-03 comes back with it: no trigger on `project`, no acceptance run, and no 409 that turns a
direct `status=DONE` request into a refusal. Who may still write the column BY HAND is the last
column of the matrix below, and it turns on one condition — whether the request carries an acting
session. `docs/project-done-gate.md` is the live page for what decides the value.

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

| Request path | No acting Session | Acceptance criteria | Project standard-set confirmation | Task verdict `PASS` | Project criterion `PASS` | Project `DONE` |
| --- | --- | --- | --- | --- | --- | --- |
| Owner REST API with a user JWT | `NON_JUDGMENT` | allowed | allowed; owner credential is recorded | allowed | allowed | allowed; this door carries no acting session |
| Headless CLI/MCP with the runner credential | no judgment role | structured items allowed; legacy text refused | allowed; runner credential is recorded | allowed | allowed since N26, under machine attribution | allowed with no session header; refused whole with `PROJECT_STATUS_NOT_SESSION_WRITABLE` when one is sent |
| One-shot judgment Session | `JUDGMENT` | refused | **refused with `PROJECT_CRITERIA_CONFIRMATION_HUMAN_ONLY`** | allowed since N26 | allowed since N26 | **refused whole with `PROJECT_STATUS_NOT_SESSION_WRITABLE`**, `DONE`, `CANCELLED` and `OPEN` alike |
| Trusted direct/internal caller with no Session | `NON_JUDGMENT` | allowed | allowed when it names its credentialed actor | allowed | allowed unless it explicitly supplies machine attribution | allowed; writes the column directly |
| Borrowed or minted owner JWT | indistinguishable from the owner REST row | allowed | allowed and indistinguishable from owner confirmation | allowed | allowed | allowed, and indistinguishable from the owner REST row |

The project standard-set confirmation row is the N22 addition. Its refusal is real for an
attributed `dispatch_origin = PROJECT_COORDINATOR` Session. For a runner call that omits the acting
Session header, or a caller that can mint/borrow an owner JWT, the row provides **audit visibility
only** (`confirmedByType`, `confirmedById`, optional acting Session, time, digest). It is not a hard
human boundary and must not be described as one. The identity-independent protection is elsewhere:
the confirmation names the exact, revision-bearing standard-set digest, so any semantic edit makes
it non-current and the projection stops deriving `DONE` until that new digest is confirmed — it
takes the column back on its next edge rather than refusing anybody's write.

The `Project DONE` column is not a rule about DONE at all. It records ONE condition, and that
condition is the presence of an acting session rather than the session's role:
`refuseProjectStatusWrite` turns away any request that carries `status` while a session is on it —
`DONE`, `CANCELLED` and `OPEN` alike, whatever that session's `dispatch_origin` — and it refuses
the request WHOLE, so the other fields it carried are not written either. That is WIDER than the
two `HUMAN_ONLY` rows, which restrict only the `JUDGMENT` role. A request with no acting session
reaches the column exactly as 0229 left it: the owner REST door passes no session at all, and the
headless and internal paths write it directly. So this is a boundary on the tool an agent holds,
not a claim about who is on the other end of a credential — and it is not what makes the column
say `DONE`: no request does that, the projection does.

There is currently no production cron job that writes these three facts. The no-Session service
default remains available for trusted internal/cron composition; adding such a writer must still
document its authority and the traceability fields it persists.

The PASS row has two service surfaces. Project acceptance records criterion conclusions; task
verification records a task verdict. Neither refuses a judgment Session any more. The project
acceptance runner endpoint still supplies a fallback machine id when the acting Session header is
absent — that is now attribution rather than a gate, so a headless runner records `PASS`, `FAIL`
and `INCONCLUSIVE` alike, and each conclusion says which evaluator produced it.

Tests lock this matrix in `coordinator-authority-boundary.spec.ts`:

- `an agent-held runner credential with no acting session can edit explicit structured criteria`;
- `an agent-held runner credential with no acting session can write task verdict=PASS`;
- `an agent-held runner credential with no acting session records acceptance PASS`;
- `a no-acting-session runner edit changes the digest and immediately invalidates the prior set confirmation`;
- `a PROJECT_COORDINATOR judgment session is refused when it tries to confirm the criteria set`;
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

1. **Judgment-role separation.** The ordinary one-shot judgment Session cannot rewrite its exam or
   confirm the standard set through its attributed path. It MAY now read that exam and conclude
   PASS: the separation that matters is between writing the standard and reading it, and only the
   first is self-grading.
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
   - a standard-set confirmation is append-only and records the complete set digest,
     `confirmedByType`, `confirmedById`, optional acting Session, and time. A headless runner or
     minted owner JWT can still produce it, exactly as the matrix says;
   - a projected `DONE` records nothing of its own. The `done_bound` audit row with source
     `AUTOMATIC_CRITERIA_EVALUATOR` that used to bind it to an accepted run went with the rest of
     that machinery in 0229, and the projection added no table to replace it: what a reviewer
     reconstructs the settlement from is the confirmation and criterion rows above, re-read. No
     requester identity exists because no requester supplies the status transition.
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
person. Criteria retain fact/binding evidence rather than an actor, and a projected DONE retains
neither — it is re-derivable from those rows rather than recorded anywhere. Both forms of
traceability are valuable, but prompts, refusals, API help, and operator documentation must name
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

## N22 result

N22 binds each confirmation to the exact revision-bearing standard-set digest and retains the
credentialed actor id and time. This mechanically guarantees that a later criterion text,
criterion kind, command, expected exit code, evidence Task, or verification method edit leaves no
standing confirmation, so the projection will not derive `DONE` until the new digest is confirmed,
and takes `DONE` back if it had already derived it. What it does not do is refuse anybody's direct
write of the column; the only rule that does is the session condition above. It guarantees workflow
separation for an attributed judgment Session and audit visibility for other credentials. It does
**not** guarantee that a human
personally performed the confirmation; that still requires one of the isolated, action-bound
step-up or external-signature designs above.

## A2 follow-up (2026-09-08): can an answered card carry a HUMAN_ONLY permission?

Design review for the chain that starts at Orbit task `34L0zqmhLgBeimGOgZ6Fh`. It asked whether a
person answering an `AskUserQuestion` card inside the project's standing coordinator session
constitutes the "human" of `CONFIRM_ACCEPTANCE_CRITERIA` — **(A)** the answered approval row IS the
permission, or **(B)** the card only prompts and the act happens on an owner-authenticated door.

The `Project DONE` column above was reconciled on 2026-09-08 and now states what the server does:
a request with no acting session writes the column directly, a request carrying one is refused
whole, and the value itself is projected. What migration `0229_project_acceptance_judgment_removal`
deleted on 2026-09-03 stays deleted. The confirmation column beside it and the paragraph under the
table still describe the N22 shape and predate `refuseSessionAuthoredConfirmation`, so read THAT
column as history. §"What is true today" below is the reasoning the DONE answer came out of, and
`docs/project-done-gate.md` is the live page.

### The premise being tested is false, and that is the finding

`refuseHumanOnlyAction` does not refuse "an agent". It refuses one dispatch origin:
`coordinator-authority.ts:223` returns null unless `principal === 'JUDGMENT'`, and
`authorityPrincipal` (`:181-187`) answers `JUDGMENT` only for
`dispatch_origin = 'PROJECT_COORDINATOR'`. §1 (`:31-34`) names "a long-lived coordination
conversation" as NON_JUDGMENT explicitly. Only `coordinator-judgment.service.ts:243,259` writes
`PROJECT_COORDINATOR`; the standing coordinator session is opened at
`projects.service.ts:2419-2427` with no `dispatchOrigin` option, so it takes the default `USER`
(`sessions.service.ts:832`).

So the A2 coordinator session is NON_JUDGMENT and is **not** refused. It could call `project_update`
with `acceptanceCriteriaItems` today: `assertHumanOnlyProjectWrites`
(`projects.service.ts:684-698`) reads that session's origin, gets NON_JUDGMENT, and
`refuseHumanOnlyAction` returns null. What is missing at the project level is therefore not
authority. It is a PLACE TO PUT THE ANSWER: `CONFIRM_ACCEPTANCE_CRITERIA` has no writer at all —
the name appears only in the table (`coordinator-authority.ts:87,118,190,203`), its refusal
message, and two specs (`coordinator-authority.spec.ts:62,100`,
`evidence-judgment-removal.pg.spec.ts:335`). `SETTLE_PROJECT_DONE` is the same
(`coordinator-authority.ts:89,123`, `coordinator-authority.spec.ts:66`).

### Decision: (B). The card prompts; the confirmation is written through an owner-authenticated door.

Not because an agent cannot press it — per §"What HUMAN_ONLY actually provides" (`:137-143`) this
tier has never claimed "impossibility of an agent performing the action", and the review above
shows the coordinator is not even refused. (B) is chosen for what it records.

**1. The approval row cannot name the act it would authorize.** `Approval`
(`schema.prisma:1456-1481`) has `sessionId`, `toolName`, `input`, `toolUseId`, `status`, `message`,
`answers`, `rememberRule`, `decidedById`, `createdAt`, `decidedAt`. There is no project column, no
action column, no digest column. The only field that could say WHICH write is being authorized is
`input`, and `input` is stored verbatim from the runner's create body
(`runner-api.controller.ts:2636`) — that is, from the agent's own tool call. A permission carried
here would be a permission whose subject is agent-authored text. The one server-held link is
`session_id` → `project.coordinator_session_id`, which reaches a PROJECT but never an ACTION or a
version, so it cannot distinguish "confirm the current standard set" from any other pending write.

**2. HUMAN_ONLY's real deliverable is exactly what (A) discards.** §"What HUMAN_ONLY actually
provides" (`:112-135`) lists three: judgment-role separation, action-specific traceability, and
tenancy/scope. (A) keeps the first for free (the coordinator was never the restricted role) and
destroys the second, because the row it would rely on records nothing about the action. The
identity-independent protection this page already identified (`:60-62`) — "the confirmation names
the exact, revision-bearing standard-set digest, so any semantic edit makes it non-current" — has a
live home that survived 0229 and 0234: `semanticRevision` / `semanticHash` on
`ProjectAcceptanceCriterionDefinition` (`schema.prisma:1961-1968`), already returned by
`project_get`. An approval row has nowhere to put that digest.

**3. Self-issued and self-answered.** Issuing: unconditional. Any tool call the engine raises
becomes an approval row (`runner-api.controller.ts:2612-2642`); nothing asks who asked or why.
Answering: today only through `POST /sessions/:id/approvals/:approvalId/decision` behind
`JwtAuthGuard` (`sessions.controller.ts:251,582-590`), and `sessions.service.ts:4982-4998` is the
sole writer of `answers` and `decidedById`. That is a real door — but it is not a boundary shaped to
be leaned on, and it has two holes already:

- the standing-grant path writes `status:'ALLOWED'` with `decidedById` NULL and `answers` NULL and
  no person involved (`runner-api.controller.ts:2629-2642`), matching non-shell tools by NAME
  (`permission-rules.ts:226-229`). It is unreachable for a claude session only because
  `SERVER_MATCHED_RUNTIMES` is `{CODEX, KIMI}` (`permission-rules.ts:117-120`), keyed on the
  session's provider — a setting, not a boundary;
- `rememberForWorkspace` (`sessions.service.ts:5022-5039`) applies no tool-name filter. "Questions
  are not repeatable" is enforced in the browser only (`ApprovalPanel.tsx:100-108`).

**4. Nothing on the server reads the answer.** `Approval.answers` is read in exactly one place, the
runner long-poll (`runner-api.controller.ts:2721`), and is not projected into `ApprovalInfo`
(`sessions.service.ts:5042-5064`). `evidenceDecisionFromAnswers`
(`coordinator-evidence-ask.ts:141-150`) has zero production callers. A2's card is server-WORDED and
agent-EXECUTED: the server writes the text into the opening message
(`coordinator-judgment-opening.ts:239` via `coordinator-evidence-ask.ts:168`) and the agent copies
it into its own `AskUserQuestion`, reads the result, and calls `task_evidence_decide`. So "the
person answered the card" reaches the apiserver only as the agent's report of it. That is
acceptable for A2, where the door's own independence check is the guarantee; it is not a thing to
promote into a permission.

**5. What the disclaimer means here.** `coordinator-authority.ts:36-45` and `:103-104`, and
`runner-projects.controller.ts:223-225`, all say the credentialed channel is not proof a human held
it. That is true of the web door too. It is not an argument for (A): it is the reason the tier's
value is route separation plus a durable, action-bound record. (A) gives up the record and gains
nothing on presence.

**If (A) is ever revisited, the approval row is still the wrong carrier.** The right-shaped one
already exists and is unwired: `ProjectRatifiedActionIntent` (`schema.prisma:2005-2029`) binds
`action` + `actionDigest` + `contractDigest` + `contractRevision` + `principalType`/`principalId`
with a single-use `commitToken`, under an immutability trigger
(`common/db-write-inventory.ts:1136-1137`), and migration
`0195_project_owner_ratification/migration.sql:1-6` describes precisely this act. It has no
application caller in the repository. That, not `Approval`, is what a card-as-permission design
would have to become — and it is a much larger undertaking than this chain.

### (B)'s cost, and where the web entry goes

The cost is real: there is no web control for `CONFIRM_ACCEPTANCE_CRITERIA` today, so choosing (B)
means building one.

It belongs on `ProjectAcceptanceCard.tsx`, the only web surface that reads
`acceptanceCriteriaItems`, mounted at `pages/ProjectsPage.tsx:1124`. Placement is constrained by
that file's own header (`:23-45`): "NO PRINCIPAL WROTE ANY OF IT. There is no field anybody sets,
no decision anybody records and nothing to overrule", plus the no-ratio / no-meter / no-per-row-
badge rules 0229 implies. A confirmation is about the complete SET — that is what
`coordinator-authority.ts:96-101` says the row grades — so it goes in its own region BELOW the
derived list, never as a per-row control, and the derived list keeps saying what it says now. The
region shows the semantic digest it would confirm, and after confirmation the digest it did confirm
and when, so "this confirmation is no longer current" is visible rather than inferred.

The coordinator card's role under (B) is a prompt with a link, not an answer surface.

### What is true today about project DONE, and what derives it

> **Answered, 2026-09-08.** The last paragraph of this section said the deriver must not be built
> on this review's authority and that it needed the owner to say the 2026-09-03 decision was being
> revisited. The owner was asked, with 0229's sentence quoted back to them, and answered: continue.
> `projects/project-done-derived.ts` is that deriver, built to the two-input shape described below
> and to nothing wider. The section is kept as written because the reasoning is what the answer was
> given about; the paragraphs below describe the position BEFORE it, and the differences now are:
>
> - the two inputs are read by `readDerivedProjectDone` and stored by
>   `storeDerivedProjectStatus`, recomputed after the owner's confirmation, on the
>   post-commit edge of any task write in the project, and after a write that restates the
>   criteria, in both directions;
> - nothing about it refuses a write, so "an agent PATCHes a project to DONE today" is still true
>   except for the one condition `refuseProjectStatusWrite` adds — the projection is what makes the
>   column come back to what the facts say, not a gate that stops the PATCH;
> - `coordinator-authority.ts`'s "Project settlement remains AUTOMATIC — no principal writes it" is
>   no longer prose describing a deleted machine. It describes this one.

Nothing derived it before that. `project.status = 'DONE'` is an ordinary column write
(`docs/project-done-gate.md:11-17`): `projects.service.ts:1899` copies `dto.status` through, and the
runner door refuses only the four authorization fields plus `coordinatorAgentId`
(`runner-projects.controller.ts:230-243`) — `status` is not among them, so an agent PATCHes a
project to DONE today. `assertHumanOnlyProjectWrites` returns at its first line when the request
carries no `acceptanceCriteriaItems` (`projects.service.ts:690`), so it never sees a status write.
`dto.ts:219-221` states this plainly.

Three places described the deleted machine when this was written, and two no longer do:
`coordinator-authority.ts`'s `SETTLE_PROJECT_DONE` comment ("Project settlement remains AUTOMATIC
— no principal writes it") was rewritten to name the projection when it landed, and this page's
own opening paragraph and matrix column were reconciled on 2026-09-08. The one still naming it is
`ProjectsService.update`'s "DONE is not a request here at all, but the evaluator's acceptance
projection" — prose to correct, not machinery to re-implement.

A derived DONE would have exactly two inputs, and only the first is a person's:

1. a CURRENT confirmation of the standard set — a confirmation row whose digest equals today's
   semantic digest (`schema.prisma:1961-1968`);
2. every stated criterion `satisfied` with `landing = LANDED`, already computed with no principal's
   opinion in it by `project-criterion-satisfaction.ts` (clauses at `:55-58`) and already returned
   by `project_get`.

Under that shape "no principal writes it" is true again in the only sense available: the human
writes the CONFIRMATION, which is a HUMAN_ONLY act about the RULER, and DONE is a projection with
no requester — which is why `SETTLE_PROJECT_DONE` stays AUTOMATIC rather than becoming a third
HUMAN_ONLY row.

**This chain must not build that deriver on this review's authority.** It reinstates a gate the
account owner declined: `0229_project_acceptance_judgment_removal/migration.sql:31-33` — "The DONE
gate is not replaced. The owner was offered a narrower guard and chose the other option" — and
`project-criterion-satisfaction.ts:31-38` carries the standing instruction that "nothing should be
added later that quietly reinstates an equivalent protection under another name" and that whether
an unsatisfied criterion blocks anything "is the owner's decision and is not smuggled in here".
Deriving DONE from `satisfied` is that reinstatement under another name. It needs the owner to say
the 2026-09-03 decision is being revisited.

*(They did, on 2026-09-08 — see the note at the head of this section. What was built is a
projection and not the gate this paragraph refused to build without them: an unsatisfied criterion
still blocks nothing, and no write is refused that was not already refused by
`refuseProjectStatusWrite`.)*

The other two follow-ups do not depend on that and may proceed. Recording a confirmation adds a
fact and gates nothing. Closing the agent's `status` door is a ROLE boundary of the kind
`runner-projects.controller.ts:216-229` already draws — "statements about the agent's own authority
... stay with the account-owner channel" — and not the acceptance gate 0229 removed, which refused
the owner's own direct write too.
