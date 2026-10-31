# TEMPORARY evidence probe — never merged

Task 34pVGFQvGcjxSppunCWTK: a fact Orbit tells a coordinator (every notification `buildCoordinatorDeliveryMessage`
writes) is drawn as one line, `<sentence> · Sent to the coordinator · time`, that opens to the words the agent read —
not as the owner's own bubble (`docs/mocks/coordinator-delivery-line/`). Adapted from the owner-answer line's probe
(`docs/evidence/answer-delivery-one-line/probe-harness`) and the ask-question-card probe's Mac half. It builds the
iPhone app's own `CompactShell` and the Mac app's own `MainView` from the tree's shell and shared sources into
throwaway apps pointed at `stub.py`, a fixture API with four coordinator conversations: a delivered evidence line with
the coordinator's long reply under it, a delivery the session never confirmed, a delivery still on the queue, and a
short one for the Mac window. The turns' words (`messages.json`) were written by the apiserver's own
`buildCoordinatorDeliveryMessage`. `DeliveryLineShotTests` finds each line by its words, opens it with the app's own
tap, scrolls past it for the sticky header, and photographs every state. All data is made up.
