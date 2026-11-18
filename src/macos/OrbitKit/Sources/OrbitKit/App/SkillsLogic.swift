import Foundation

// Pure logic for the Skills directory: fold every runner's reported skills/commands into groups
// by owning agent (host-level → a "Shared" group that sinks last), with a name/description
// search filter. Mirrors web SkillsPage. UI-free, unit-tested.

public struct SkillGroup: Equatable, Sendable, Identifiable {
    public let id: String          // "<runnerId>:<agentId|shared>"
    public let agentId: String?    // nil = Shared (host-level)
    public let title: String       // agent display name, or "Shared"
    public let runnerName: String
    public let online: Bool
    public let skills: [SlashCommandInfo]
    public let commands: [SlashCommandInfo]

    public var count: Int { skills.count + commands.count }
}

public enum SkillsLogic {
    /// Group each runner's (search-filtered) skills/commands by owning agent. `agentName` maps an
    /// agentId → display name. Host-level assets (no agentId) collect into a "Shared" group that
    /// sorts last; agent groups sort by title then runner name.
    public static func grouped(runners: [Runner],
                               agentName: (String) -> String,
                               search: String = "") -> [SkillGroup] {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        func match(_ s: SlashCommandInfo) -> Bool {
            q.isEmpty
                || s.name.lowercased().contains(q)
                || (s.description?.lowercased().contains(q) ?? false)
        }

        var groups: [SkillGroup] = []
        for r in runners {
            let skills = (r.skills ?? []).filter(match)
            let commands = (r.commands ?? []).filter(match)
            var keys = Set<String>()                       // "" = Shared (host-level)
            for s in skills { keys.insert(s.agentId ?? "") }
            for c in commands { keys.insert(c.agentId ?? "") }
            let runnerName = RunnerPageFormat.displayName(r)
            for k in keys {
                let shared = k.isEmpty
                groups.append(SkillGroup(
                    id: "\(r.id):\(shared ? "shared" : k)",
                    agentId: shared ? nil : k,
                    title: shared ? "Shared" : agentName(k),
                    runnerName: runnerName,
                    online: r.online ?? false,
                    skills: skills.filter { ($0.agentId ?? "") == k },
                    commands: commands.filter { ($0.agentId ?? "") == k }
                ))
            }
        }
        return groups.sorted { a, b in
            if (a.agentId == nil) != (b.agentId == nil) { return b.agentId == nil }  // Shared sinks last
            if a.title != b.title { return a.title.localizedCaseInsensitiveCompare(b.title) == .orderedAscending }
            return a.runnerName.localizedCaseInsensitiveCompare(b.runnerName) == .orderedAscending
        }
    }
}
