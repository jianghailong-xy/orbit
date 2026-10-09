import Foundation

/// The engines a session can run on, each by its CLI's own product name — shared `ALL_ENGINES` and
/// `ENGINE_CLI_NAMES` (src/shared/src/providerEngines.ts), which `SettingsCopyParityTests` reads back out
/// of that file — and the ones a key runs on. A key is no engine's: one DeepSeek key runs on Claude Code,
/// OpenCode and DeepSeek Harness alike.
public enum ProviderEngines {
    /// Every engine, in the order a picker lists them, with its CLI's name.
    public static let names: [(engine: String, name: String)] = [
        ("claude", "Claude Code"),
        ("codex", "Codex"),
        ("kimi", "Kimi Code"),
        ("antigravity", "Antigravity CLI"),
        ("opencode", "OpenCode"),
        ("dsh", "DeepSeek Harness"),
    ]

    /// "Antigravity CLI" for `antigravity`; an engine this build doesn't know, by the name it came as.
    public static func cliName(_ engine: String) -> String {
        names.first { $0.engine == engine }?.name ?? engine
    }

    /// The engines a key runs on, its default first, as the server answers for it (`engines`). From an
    /// older server, which doesn't, the one its runtime names — where its sessions ran before.
    public static func of(_ key: ConfiguredProvider) -> [String] {
        key.engines ?? [key.runtime ?? "claude"]
    }
}
