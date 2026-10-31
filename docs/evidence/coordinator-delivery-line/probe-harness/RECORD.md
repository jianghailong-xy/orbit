# The probe that took the iPhone and Mac pictures — kept as a record

It ran three times from the push-triggered branch `probe/coordinator-delivery-line`, which was deleted
afterwards together with its `probe/coordinator-delivery-line-results` branch. On that branch these files
sat under `.cdl-probe/`, and `client.probe.yml` replaced `.github/workflows/client.yml`. Nothing here is
built by this repository.

Each probe commit was the task branch merged with main plus this harness, so the `macos` and `ios` jobs ran
client.yml's own gates on that merged tree, and `shots` drove the real iPhone and Mac apps against
`stub.py`. `messages.json` holds the three delivery messages the apiserver's own
`buildCoordinatorDeliveryMessage` wrote for the fixture's facts (`gen-messages.cjs`, run on the compiled
apiserver of the task branch). These are the files of the third run; `../probe-results.txt` gives each
run's commit, jobs and results, and what the first two found.
