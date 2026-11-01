# The probe that took the iPhone and Mac pictures, kept as a record

It ran twice from the push-triggered branch `probe/criteria-reply-session`. That branch was deleted afterwards,
together with `probe/criteria-reply-session-results` and `probe/criteria-reply-session-gates`. On the probe branch
these files sat under `.crs-probe/`, and `client.probe.yml` replaced `.github/workflows/client.yml`. Nothing here is
built by this repository.

Each probe commit was the task branch, merged with main, plus this harness. `client.yml`'s own gates ran unchanged on
the task branch itself (dispatched on the `-gates` branch), so the probe workflow holds only the pictures (`shots`)
and the job that pushed them to the results branch (`report`). `messages.json` holds the two replies the apiserver's
own `criteriaDecisionReplyMessage` wrote (`gen-messages.cjs`, run on the compiled apiserver of the task branch).
These are the files of the second run. `../probe-results.txt` gives each run's commit, jobs and results, and what
the first run got wrong.
