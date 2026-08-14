import Foundation

/// The folded row of a run of tool calls: what it did, how it went, and — only when that is the
/// reason someone would look — the one call still running or the first that failed.
///
/// Mirrors web's `summarizeToolGroup`. Kept out of the view so the wording is unit-testable
/// off-device, which is the only way it gets tested at all before a TestFlight build.
public struct ToolGroupSummary: Equatable, Sendable {
    /// `Bash × 3` when the run is one kind of call, `Tools × 9` when it is several.
    public let title: String
    /// `1 running · 5 succeeded` — what is live, what broke, what is done, in that order.
    public let counts: String
    /// `Bash × 2 · Read × 2 · Edit × 2`, or nil when the title already says the same thing.
    public let breakdown: String?
    /// The one call worth naming, if any.
    public let lead: Lead?
    public let symbol: String
    public let tone: ToolTone
    public let status: ToolStatus

    public struct Lead: Equatable, Sendable {
        public enum Kind: String, Equatable, Sendable {
            case running = "Running"
            case failed = "Failed"
        }
        public let kind: Kind
        public let text: String
        public let mono: Bool

        public init(kind: Kind, text: String, mono: Bool) {
            self.kind = kind
            self.text = text
            self.mono = mono
        }
    }

    public init(title: String, counts: String, breakdown: String?, lead: Lead?,
                symbol: String, tone: ToolTone, status: ToolStatus) {
        self.title = title
        self.counts = counts
        self.breakdown = breakdown
        self.lead = lead
        self.symbol = symbol
        self.tone = tone
        self.status = status
    }

    public static func make(_ cards: [ToolCard]) -> ToolGroupSummary {
        // `describe` is eager where web's is lazy — it builds an Edit card's diff up front — so the
        // per-card pass, which only needs a label, runs against `.null` input. Every branch reads
        // its input through optional subscripts, and a groupable tool's label never depends on it.
        // Only the single call the row names is described whole, below.
        let chips = cards.map { ToolDisplay.describe(name: $0.name, input: .null, status: $0.status, id: $0.id) }

        var order: [String] = []
        var tally: [String: Int] = [:]
        for chip in chips {
            if tally[chip.label] == nil { order.append(chip.label) }
            tally[chip.label, default: 0] += 1
        }
        // Commonest kind first. Swift's sort isn't stable, so ties fall back to first appearance —
        // otherwise the row could reshuffle its own breakdown as later calls land.
        let kinds = order.enumerated()
            .sorted { a, b in
                let ca = tally[a.element] ?? 0
                let cb = tally[b.element] ?? 0
                return ca == cb ? a.offset < b.offset : ca > cb
            }
            .map { (label: $0.element, count: tally[$0.element] ?? 0) }

        let sameKind = kinds.count == 1
        let title = sameKind ? "\(kinds[0].label) × \(cards.count)" : "Tools × \(cards.count)"

        let running = cards.filter { $0.status == .running }.count
        let failed = cards.filter { $0.status == .error }.count
        let succeeded = cards.count - running - failed
        var parts: [String] = []
        if running > 0 { parts.append("\(running) running") }
        if failed > 0 { parts.append("\(failed) failed") }
        if succeeded > 0 { parts.append("\(succeeded) succeeded") }

        // One call earns a slot on the row, and only while it is the reason to look: the oldest
        // still in flight (progress — the *oldest*, so parallel calls landing can't make the label
        // jump backwards), or, once nothing is running, the first failure, which is usually the
        // cause of any that followed it. Any other call is an arbitrary anchor: a nine-step run
        // tends to end on some small `ls`, which stands for nothing.
        let leadCard = cards.first(where: { $0.status == .running })
            ?? cards.first(where: { $0.status == .error })
        let lead: Lead? = leadCard.flatMap { card in
            let d = ToolDisplay.describe(name: card.name, input: card.input, status: card.status, id: card.id)
            let kind: Lead.Kind = card.status == .running ? .running : .failed
            if let p = d.path { return Lead(kind: kind, text: p.base, mono: true) }
            if let s = d.summary, !s.isEmpty { return Lead(kind: kind, text: s, mono: d.summaryMono) }
            return nil
        }

        return ToolGroupSummary(
            title: title,
            counts: parts.joined(separator: " · "),
            breakdown: sameKind ? nil : kinds.map { "\($0.label) × \($0.count)" }.joined(separator: " · "),
            lead: lead,
            symbol: sameKind ? (chips.first?.symbol ?? "wrench.and.screwdriver") : "wrench.and.screwdriver",
            tone: sameKind ? (chips.first?.tone ?? .plain) : .plain,
            status: running > 0 ? .running : (failed > 0 ? .error : .ok))
    }
}
