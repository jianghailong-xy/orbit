import SwiftUI
import UIKit
import OrbitKit

// TEMPORARY evidence probe (see ../../README.md). One screen per launch (`-screen <name>`), drawn by the
// app's own pages — Generated/WikiView.swift copied whole, and the settings and run pages cut verbatim
// out of WikiSettingsView.swift and WikiRunView.swift — over the reads in ProbeData.swift.

@main
struct WikiProbeApp: App {
    var body: some Scene {
        WindowGroup { ProbeRoot() }
    }
}

struct ProbeBundle: Decodable {
    let now: String
    let spaceAuto: WikiSpace
    let spaceOn: WikiSpace
    let entries: [WikiEntry]
    let run: WikiChangeset
    let challenge: WikiChangeset
    let timeline: [WikiTimelineItem]
    let unreviewed: WikiEntryDetail
    let auto: WikiEntryDetail
    let web: WikiEntryDetail
    let challenged: WikiEntry
}

enum ProbeData {
    static let bundle = try! JSONDecoder().decode(ProbeBundle.self, from: Data(probeDataJSON.utf8))
    static let now = RelativeTime.parse(bundle.now)!
    static var home: WikiHomeContent {
        WikiHomeContent(space: bundle.spaceAuto, spaces: [bundle.spaceAuto], entries: bundle.entries,
                        timeline: bundle.timeline, proposals: 3, runs: [bundle.run, bundle.challenge])
    }
    /// The challenge first, then the run's spot check — Review's own order for the two changesets.
    static var cards: [WikiLogic.ReviewCard] { WikiLogic.reviewCards([bundle.challenge, bundle.run]) }
    /// The verdict behind an entry, read off the op that carries it — the screen's own join.
    static func verification(_ entry: WikiEntry) -> WikiOpVerification? {
        let ops = (bundle.run.ops ?? []) + (bundle.challenge.ops ?? [])
        return ops.first { $0.verification != nil && ($0.resultEntryId == entry.id || $0.entryId == entry.id) }?.verification
    }
    static let workspaces = [WikiPickerOption(id: "ws-orbit", label: "orbit · wikova"),
                             WikiPickerOption(id: "ws-dev", label: "wikova-develop · wikova")]
    static let providers = [WikiPickerOption(id: "local-vllm", label: "local-vllm · qwen3.8-27b-fp8")]
    static func workspaceLabel(_ id: String) -> String? { workspaces.first { $0.id == id }?.label }
}

struct ProbeRoot: View {
    private var screen: String {
        let args = ProcessInfo.processInfo.arguments
        guard let at = args.firstIndex(of: "-screen"), at + 1 < args.count else { return "home" }
        return args[at + 1]
    }

    var body: some View {
        switch screen {
        case "settings":
            Pushed { WikiSettingsPage(space: ProbeData.bundle.spaceAuto, workspaceLabel: ProbeData.workspaceLabel) }
        case "settings-on":
            Pushed { WikiSettingsPage(space: ProbeData.bundle.spaceOn, workspaceLabel: ProbeData.workspaceLabel) }
        case "setup":
            Pushed {
                WikiSettingsPage(space: ProbeData.bundle.spaceAuto, workspaceLabel: ProbeData.workspaceLabel)
                    .sheet(isPresented: .constant(true)) {
                        WikiMaintenanceForm(workspaces: ProbeData.workspaces, providers: ProbeData.providers,
                                            initial: WikiMaintenanceChoice(workspaceID: "ws-orbit", provider: "local-vllm",
                                                                           dailyRunLimit: 8),
                                            enabled: false) { _ in false }
                    }
            }
        case "entry-unreviewed": entry(ProbeData.bundle.unreviewed)
        case "entry-auto":       entry(ProbeData.bundle.auto)
        case "entry-web":        entry(ProbeData.bundle.web)
        case "run":
            Pushed { WikiRunPage(changeset: ProbeData.bundle.run, entries: ProbeData.bundle.entries) }
        case "revert":
            Pushed {
                // The alert `WikiRunView` puts over the page, in its words.
                WikiRunPage(changeset: ProbeData.bundle.run, entries: ProbeData.bundle.entries)
                    .alert(WikiModeCopy.revertTitle, isPresented: .constant(true)) {
                        Button(WikiModeCopy.cancel, role: .cancel) {}
                        Button(WikiModeCopy.revertRunConfirm, role: .destructive) {}
                    } message: {
                        let summary = WikiModeLogic.runSummary(ProbeData.bundle.run, entries: ProbeData.bundle.entries)
                        Text(WikiModeLogic.revertBody(summary) + "\n" + WikiModeCopy.revertKeeps)
                    }
            }
        case "review":
            Pushed {
                WikiReviewPage(cards: ProbeData.cards,
                               entry: { id in id == ProbeData.bundle.challenged.id ? ProbeData.bundle.challenged : nil },
                               now: ProbeData.now)
            }
        default:
            NavigationStack {
                WikiHomePage(content: ProbeData.home, now: ProbeData.now)
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Image(systemName: "line.3.horizontal").accessibilityLabel("Open navigation")
                        }
                    }
            }
        }
    }

    private func entry(_ detail: WikiEntryDetail) -> some View {
        Pushed {
            WikiEntryPage(detail: detail, now: ProbeData.now, verification: ProbeData.verification(detail.entry))
        }
    }
}

/// A page one level into its section's stack, so the bar carries the back button it has in the app.
struct Pushed<Page: View>: View {
    @ViewBuilder let page: () -> Page
    @State private var path = ["page"]

    var body: some View {
        NavigationStack(path: $path) {
            Text(WikiCopy.title)
                .navigationTitle(WikiCopy.title)
                .navigationDestination(for: String.self) { _ in page() }
        }
    }
}
