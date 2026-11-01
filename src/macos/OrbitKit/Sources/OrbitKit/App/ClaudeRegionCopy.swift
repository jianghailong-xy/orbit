import Foundation

/// The Claude region check's words — a hand-copy of the web's `src/web/src/lib/claudeRegionCopy.ts`
/// (docs/claude-region-check-contract.md, "Copy of record"; boards 02–04 of
/// docs/mocks/claude-region-check), held to it by `ClaudeRegionCopyParityTests`. Names match the
/// web's, for the words these apps draw. Kept apart from `RunnerPageCopy`, whose names correspond one
/// to one with runnerCopy.ts. `machine` is the runner's name and `region` is `Runner.region.name`,
/// never a place read out of a sentence.
public enum ClaudeRegionCopy {
    /// The code every region refusal carries (`CLAUDE_REGION_UNSUPPORTED`, src/shared/src/dto.ts): the
    /// start of a held session's `error`, and the session card's subject.
    public static let CLAUDE_REGION_UNSUPPORTED = "CLAUDE_REGION_UNSUPPORTED"

    /// Anthropic's own page (`CLAUDE_REGIONS_SOURCE_URL`, src/shared/src/claude-regions.ts), linked
    /// wherever a sentence says Anthropic doesn't offer Claude somewhere.
    public static let CLAUDE_REGION_SUPPORTED_REGIONS = "Supported regions"
    public static let CLAUDE_REGION_SUPPORTED_REGIONS_URL = "https://www.anthropic.com/legal/supported-regions"

    /// The session card's why.
    public static func claudeRegionCantUseAnthropicOn(machine: String) -> String {
        "Claude Code can’t use Anthropic on \(machine)"
    }

    /// The session card's body: the refusal sentence behind its code (contract §9, the shared
    /// `claudeRegionRefusedError`).
    public static func claudeRegionConnectionIsIn(machine: String, region: String) -> String {
        "\(machine)’s connection to Anthropic is in \(region), where Anthropic doesn’t offer Claude."
    }

    /// The session card's subject line: the code and the place's ISO code.
    public static func claudeRegionSubject(code: String?) -> String {
        code.map { "\(CLAUDE_REGION_UNSUPPORTED) · \($0)" } ?? CLAUDE_REGION_UNSUPPORTED
    }

    /// When the region was last checked, and where Claude's connection came out: the session card's
    /// machine words, and the second line under the machine page's note.
    public static func claudeRegionChecked(when: String, region: String, viaProxy: Bool) -> String {
        "Checked \(when) · Claude’s connection: \(region) (\(viaProxy ? "through a proxy" : "no proxy"))"
    }

    /// The session card's three ways out.
    public static let CLAUDE_REGION_USE_ANOTHER_PROVIDER = "Use another provider"
    public static let CLAUDE_REGION_MOVE_TO_ANOTHER_MACHINE = "Move to another machine"
    public static let CLAUDE_REGION_CHECK_AGAIN = "Check again"

    /// Check again where a runner page draws it: that page's presses are title case (`RunnerPageCopy`'s
    /// Sign In, Update Engines Now), and board 03 draws its capsule `Check Again`.
    public static let CLAUDE_REGION_CHECK_AGAIN_TITLE = "Check Again"

    /// A held session's status words, in the session list and the header.
    public static func anthropicUnavailableOn(machine: String) -> String { "Anthropic unavailable on \(machine)" }

    /// The machine page's attention line, and its Needs Attention card's title.
    public static let CLAUDE_REGION_ATTENTION = "Claude Code can’t use Anthropic here"

    /// The Claude Code row's state, and an Anthropic credential's reason in the pickers.
    public static let CLAUDE_REGION_NOT_SUPPORTED = "Region not supported"

    /// The note under the machine page's Claude Code row.
    public static func claudeRegionMachineNote(region: String) -> String {
        "Claude’s connection from this machine is in \(region), where Anthropic doesn’t offer Claude, so Orbit won’t use Anthropic accounts or keys here, or start a Claude sign-in. Claude Code still runs with other providers’ keys."
    }

    /// The attention item's detail, as a machine page's Needs Attention card says it (board 03).
    public static func claudeRegionAttentionDetail(region: String) -> String {
        "Anthropic doesn’t offer Claude in \(region)."
    }

    /// The new session hero's link where nothing on the page fixes the reason: it explains instead.
    public static let CLAUDE_REGION_DETAILS = "Details"

    /// Check again could not be asked for (the runner went offline, or is too old to check).
    public static let CLAUDE_REGION_CHECK_FAILED = "Couldn’t check again"
}
