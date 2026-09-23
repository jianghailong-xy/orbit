import Foundation

// What the bar pinned to the top of a console says about the turn it points back at.
//
// The bar names the last turn that has scrolled above the fold, so a reader halfway down a long
// answer still knows what it is answering. It called every one of them "↑ Your question" and drew
// the turn's text beside it — which for a wake is the head line's raw UUID, under a label saying
// the person typed it. On the account owner's screenshot (2026-09-17) that label sat directly above
// the card reading "Queued by a watch, not typed by you": one screen saying both.
//
// A wake is still the turn the bar points at — tapping it is how you get back to this round — so
// what changes is only the two words in place: the label becomes the card's own title and the text
// the line under it, which is the same sentence the card underneath already reads. Nothing new is
// written here; both come from `WatchWakeCard` / `BackgroundWakeCard`, so a wake reads the same in
// the bar as in the card it points at.
//
// This is the whole rule, and it is here rather than in the view so both clients can share it and
// Linux can test it: `ConsoleView.stickyQuestion` draws what it returns, and the browser stamps the
// same pair onto the card's root (`data-sticky-label` / `data-sticky-text`) for `WorkspaceView`'s
// scanner to read. `WatchWakeCopyParityTests` / `BackgroundWakeCopyParityTests` hold the two ends
// to the same words.

/// The two words the sticky bar draws for one turn: what kind of turn it was, and what it said.
public enum StickySummary {
    /// The arrow every label opens with — the bar points up at the turn it names.
    public static let arrow = "↑ "

    /// The label over a turn the person actually typed. The one label that is not a card's title,
    /// and the only wording on this bar that predates the wakes.
    public static let yourQuestion = "\(arrow)Your question"

    /// What the bar says about one user turn, read off the same fields the transcript reads a card
    /// out of: a watch's wake is in the turn's own `text`, the control plane's wake in the `note` it
    /// recorded beside it, and an exception item's delivery in the payload recorded beside it too
    /// (`itemCard`). A turn that is none of them is the person's, unchanged.
    ///
    /// The order is the transcript's (`TranscriptItemView`, web's `NodeView`): the item card first,
    /// then a watch's wake, then the control plane's, then the person's words — so the bar can never
    /// name a turn something other than what the card under it is.
    public static func of(text: String, note: String? = nil,
                          itemCard: OpenItemDelivery? = nil,
                          startedCard: ProjectStarted? = nil) -> (label: String, text: String) {
        if let card = itemCard {
            let summary = OpenItemDeliveryCard.sticky(card)
            return (arrow + summary.label, summary.text)
        }
        if let card = startedCard {
            let summary = ProjectStartedCard.sticky(card)
            return (arrow + summary.label, summary.text)
        }
        if let wake = WatchWakeText.parse(text) {
            return (arrow + WatchWakeCard.title(wake.kind), WatchWakeCard.why(wake))
        }
        if let wake = BackgroundWakeText.parse(note) {
            return (arrow + BackgroundWakeCard.title(wake), BackgroundWakeCard.summary(wake))
        }
        return (yourQuestion, text)
    }
}
