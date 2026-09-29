# Orbit demo repo

This tiny fixture gives a new Orbit operator a safe first checkout. It has no network calls, credentials, or
production assumptions. Copy this directory into a standalone Git repository (or point a workspace at this
checkout) and ask an agent to run the tests, explain the code, or make a small reviewed change.

## Try it in Orbit

1. Put this directory in a Git repository and clone it on the machine where the runner is installed.
2. In Orbit, create a workspace for that checkout and select the runner.
3. Create a task such as:

   > Run `npm test`, explain why the greeting test is useful, and propose one small improvement. Do not edit files
   > until I approve the plan.

4. Review the transcript and any approval card. If you enable worktree isolation, review the diff before merging.

The fixture is deliberately boring: the point is to verify the path from a repository to a runner, not to benchmark
an agent or expose a real system.

## Run locally

```bash
npm test
```
