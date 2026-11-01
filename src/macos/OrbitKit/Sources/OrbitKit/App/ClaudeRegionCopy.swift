import Foundation

/// The Claude region check's words on a machine's attention item — a hand-copy of the web's
/// `src/web/src/lib/claudeRegionCopy.ts` (docs/claude-region-check-contract.md, "Copy of record"),
/// held to it by `ClaudeRegionCopyParityTests`. Kept apart from `RunnerPageCopy`, whose names
/// correspond one to one with runnerCopy.ts.
public enum ClaudeRegionCopy {
    /// The machine page's attention line, and its Needs Attention card's title.
    public static let CLAUDE_REGION_ATTENTION = "Claude Code can’t use Anthropic here"

    /// The attention item's detail, as a machine page's Needs Attention card says it (board 03).
    public static func claudeRegionAttentionDetail(region: String) -> String {
        "Anthropic doesn’t offer Claude in \(region)."
    }
}
