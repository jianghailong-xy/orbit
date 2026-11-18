import SwiftUI
import OrbitKit

// Evidence probe (see ../README.md): where a launch opens. `-probe.scene` names it:
//   drawer   — the rail with its Shared with me group (iPhone: the drawer itself; Mac: the guest view
//              of G1 beside the sidebar)
//   running  — G1, opened BY ID the way a deep link opens a session: the owner's read 404s, the
//              guest door answers, and the guest view is drawn (step 4)
//   waiting  — G2, its agent waiting on its owner
//   ended    — G3, over
//   gone     — G4, no longer shared
// `-probe.send <words>` (Mac only — the phone presses its real composer in the UI test): the message
// is sent through the guest door before the view opens, so the picture shows it in the transcript.
enum ProbeArgs {
    static func arg(_ name: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: name), args.count > i + 1 else { return nil }
        return args[i + 1]
    }

    static var scene: String { arg("-probe.scene") ?? "running" }

    /// Each fresh launch starts from what the stub serves, not from lists an earlier launch cached.
    static func wipeIfFresh() {
        guard ProcessInfo.processInfo.arguments.contains("-probe.fresh"),
              let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return }
        try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
    }

    @MainActor
    static func land(_ model: AppModel) async {
        if let base = model.baseURL {
            let api = APIClient(baseURL: base, tokenStore: InMemoryTokenStore())
            model.user = try? await api.me()
            if let words = arg("-probe.send") {
                _ = try? await api.sendGuestTurn(sessionFor(scene), clientTurnId: UUID().uuidString, content: words)
            }
        }
        await model.agents?.load()
        await model.loadSharedWithMe()
        // The shell restores its own landing as it comes up, so the route is walked again after a
        // gap: the last one lands on a shell that has finished.
        for _ in 0..<3 {
            try? await Task.sleep(for: .seconds(2))
            model.selectedAgentID = model.agents?.items.first?.id
            switch scene {
            case "running":
                model.route(to: .session("G1"))
            default:
                model.openGuestSession(sessionFor(scene))
            }
        }
    }

    static func sessionFor(_ scene: String) -> String {
        switch scene {
        case "waiting": return "G2"
        case "ended": return "G3"
        case "gone": return "G4"
        default: return "G1"
        }
    }
}
