# TEMPORARY evidence probe — never merged

Smart model selection on the native clients (docs/model-routing-design.md §9, commits 74ab0dbb2, f6d57aa5e, 7e35c466d):
the task detail's Suggested picker under Assignee, the Model row's "✦ Smart selection", the
coordinator's reason under the Details card, the Runs rows (what each ran on, "✦ M", amber
"✦ L ↑", the purple "would have picked" line of a shadow run, ⓘ and its Why sheet), the Agent's
Task runs switch, and a task run's composer chip (✦ on a light blue ground) and its menu.

This probe builds the iOS app's shared sources into a throwaway app that launches straight into
one real surface (`-probe.surface task | agent | console`): the compact Tasks stack routed to a
task (`TaskDetailPage`), `AgentSettingsSheet` over the Agents stack, or the Agents stack routed to
a task run's console (`ConsoleView` and its `ComposerView`) — pointed (`-orbit.instance`) at
`ios/stub.py`, a fixture API with one workspace (smart selection on), its runner's model
catalogue, one task with three runs, and that task's second run as a session. `PATCH /tasks/:id`
and `PATCH /agents/:id` apply and log their bodies. UI tests on the newest iPhone simulator
photograph each surface and write what the accessibility tree exposed beside each picture.

Fixture titles and data are made up; nothing here is real data.
