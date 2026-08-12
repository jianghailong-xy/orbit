# Orbit

**Your coding agents, running on your machines, in an app you can actually use.**

You already have agents that can write code. What you don't have is a place to run five of
them at once, keep track of what they're doing, tell one of them "no, not that command," and
still see the whole thing from your phone on the way home.

And when the work is bigger than one sitting — a migration, a refactor, a month-long
project — you don't have anywhere for it to live except a chat window that eventually
forgets.

That's Orbit.

---

## A day with it

**9:12 — you give it the backlog.** Four things need doing: a flaky test, a dependency bump,
a migration script, and "figure out why last night's ingestion job stalled." You write them
as tasks, mark the migration as blocked by the bump, and hit run. Orbit spreads them across
the machines you've connected and starts working. You go to a meeting.

**9:40 — your phone buzzes.** The ingestion agent wants to run something against the
production cluster. You read the exact command on the approval card, tap **Allow**, and
optionally tell it not to ask again for that kind of command. It keeps going.

**11:05 — you read what happened.** Three tasks are done. Each one worked in its own copy of
the repo, so none of them stepped on the others. You open the diff, skim the file tree, and
merge two of them from the UI. The third took a wrong turn, so you open its session and just
*talk to it*: "you changed the wrong helper — revert that and fix the caller instead." It
picks up mid-conversation, remembering everything from before.

**16:30 — you close the laptop.** The agents keep running on your machines. When one of them
needs you, your phone tells you.

**Next Tuesday — the migration is still going.** It was never a one-day job. It's a task list
with a dozen items, half of them done, each with a comment thread; the agents working it have
turned over several times since Monday and none of that mattered, because the plan was never
sitting in a conversation that could end.

---

## What you can do

### Talk to an agent that lives somewhere else

Open a session and you get a live console: the agent's thinking, its edits, its tool calls,
streaming as they happen. Type a follow-up mid-answer and it queues neatly instead of
tangling the reply — and you can cancel it before it lands. Interrupt anytime. Drop in
screenshots and files. Rename sessions, tag them, search across every conversation you've
ever had with ⌘K.

### Hand it a list and walk away

Write tasks, group them into lists, and say which ones depend on which. Orbit hands them out
to whichever of your machines is free, keeps them moving, and starts the downstream work the
moment its prerequisites land. You come back to results instead of babysitting a terminal.

### Run projects that outlive any one conversation

Some work doesn't finish in an afternoon. A migration, a test-suite rescue, a rewrite that
takes three weeks — the kind of thing where the plan matters more than any single session.

In Orbit the plan doesn't live in a chat window. It lives in the task graph: a list of work
items, who they're assigned to, what blocks what, and a comment thread on each one. Sessions
come and go against that plan. An agent exhausts its context, a machine reboots, you take the
weekend off — the project is still there, still knows what's done and what's next, and picks
up without you re-explaining it.

You can also let an agent hold the plan. Give one the orchestrator role and it will break the
goal into tasks, wire up the dependencies, and hand pieces to *other* agents — starting their
sessions, checking on them, reading what came back, leaving notes on the tasks, and searching
across everything that's been done so far. You supervise a project instead of supervising a
prompt. (It's off by default, per agent, and everything an orchestrator does is done under
your account, visible on the same board you're looking at.)

### Spread the work across a fleet

Agents don't have to share a machine, and often shouldn't. Connect as many as you like and
give each one labels — `gpu`, `prod-access`, `mac` — then route work to machines that can
actually do it: this task needs the box with cluster access, that one can run anywhere. Cap
how many sessions each machine takes at once. Add a laptop for the afternoon and remove it
later; the queue just redistributes.

The upshot: a plan on one side, a pool of machines on the other, and Orbit keeping the two
matched up while you're not watching.

### Say yes or no to the risky step

An agent that never asks is a liability; an agent that asks about everything is a chore.
Orbit gives you the dial. Pick how much freedom each agent gets, and hand it a specific
allowlist ("you may run `kubectl`, nothing else"). Anything outside that surfaces as an
approval card — the actual command, allow or deny, and a "don't ask me again for this" if
you're tired of seeing it. Nothing blocks in silence waiting for a human who isn't looking.

### Run several agents on one repo without the mess

Every session gets its own private copy of the repository. Five agents can work at once and
none of them overwrite another's edits. When you're happy, review the diff full-screen and
merge to main without leaving the app; when you're not, throw the session away and nothing
else is affected.

### Let agents reach your actual systems

This is the part hosted agent tools can't do. Your agents run on **your** machines — the ones
that already have your internal CLIs, your cluster access, your VPN, your SSH keys. So
"check why the job failed" is a question the agent can go and answer, instead of something
you answer by pasting logs into a chat box. Your engine logins never leave those machines.

### Pick your engine — and your account

Each agent runs Claude Code, Codex, Kimi, or OpenCode, whichever you point it at. Sign in
from the UI, including from your phone. Prefer a different model vendor? Connect one with
your own API key and the agent uses that instead.

### Use it from wherever you are

A web app that works on a laptop and a phone browser. A native Mac app with a menu-bar extra
and desktop notifications. An iPhone/iPad app with push, so approvals find you. All three
show the same sessions, live.

### See what it's costing

Every session reports what it spent in tokens and dollars, rolled up per agent and per user
on a dashboard. (These are the engine's own numbers — treat your provider's bill as the
final word.)

---

## When things go wrong

The interesting part of a tool like this is what happens on a bad day.

- **You reboot the machine.** Running sessions finish their current turn, then the runner
  drains and comes back. The conversation resumes where it left off.
- **A machine drops off the network.** Its sessions are marked failed within about a minute
  instead of hanging forever, and the queue keeps moving on your other machines.
- **You hit a rate limit or the API hiccups.** Orbit retries on its own and picks the session
  back up rather than leaving you a dead session to notice hours later.
- **You closed the tab.** Everything keeps running. The transcript is on the server, so any
  device catches up on the whole thing.
- **The agent runs out of context.** On a long project this is inevitable. It matters less
  than usual, because the plan is in the task graph rather than in that conversation — a
  fresh session reads the tasks, the dependencies and the comment history and carries on.
- **The agent goes off the rails.** Interrupt it, tell it what it got wrong, or discard the
  session — its copy of the repo goes with it.

---

## How it works, briefly

You connect machines to Orbit the way you'd add a self-hosted CI runner: one command, one
small binary, installs itself as a background service. Those machines dial out to your Orbit
server and ask for work — nothing dials *in*, so a laptop, an office box, or a VM inside a
VPC all work with no ports opened and no tunnel.

Orbit itself is self-hosted: you run it with one `docker compose up`, and it lives on your
infrastructure alongside everything else. There's no sign-up page — the first person to open
a fresh install becomes the admin and adds everyone else.

---

## Who gets the most out of it

- **People running agents against their own infrastructure**, where the tools that matter
  only exist inside the network.
- **Small teams sharing a repo**, who want parallel agents without five terminal windows and
  five broken checkouts.
- **Anyone running a project rather than a prompt** — work measured in weeks, spread over
  several agents and several machines, that has to survive every one of them restarting.
- **Anyone who doesn't sit still.** Queue from the laptop, approve from the phone, read the
  diff on the couch.

---

## What it doesn't do yet

No recurring schedules — you start work, it doesn't start itself on a cron. No inbound
task sources yet either (pulling work from a ticket system or a chat tool); both are designed
for, not built.

Self-hosted. MIT licensed.
