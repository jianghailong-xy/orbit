import SwiftUI
import UIKit
import OrbitKit

// TEMPORARY evidence probe (see ../../README.md). One screen per launch (`-screen <name>`), drawn by the
// app's own pages — Generated/WikiView.swift and WikiArticleView.swift copied whole, and the run page cut
// verbatim out of WikiRunView.swift — over the reads in ProbeData.swift. Review holds nothing: every run
// here is read by its own id, as the app reads it.

@main
struct WikiProbeApp: App {
    var body: some Scene {
        WindowGroup { ProbeRoot() }
    }
}

struct ProbeBundle: Decodable {
    let now: String
    let space: WikiSpace
    let entries: [WikiEntry]
    let timeline: [WikiTimelineItem]
    let runA: WikiChangesetView
    let runB: WikiChangesetView
    let unreviewed: WikiEntryDetail
    let article: WikiArticle
}

enum ProbeData {
    static let bundle = try! JSONDecoder().decode(ProbeBundle.self, from: Data(probeDataJSON.utf8))
    static let now = RelativeTime.parse(bundle.now)!
    /// The home as `WikiModel.loadHome` builds it: the three reads, then each folded run by its own read.
    static var home: WikiHomeContent {
        WikiHomeContent(space: bundle.space, spaces: [bundle.space], entries: bundle.entries,
                        timeline: bundle.timeline, proposals: 0, runs: [bundle.runA, bundle.runB])
    }
}

struct ProbeRoot: View {
    private var screen: String {
        let args = ProcessInfo.processInfo.arguments
        guard let at = args.firstIndex(of: "-screen"), at + 1 < args.count else { return "home" }
        return args[at + 1]
    }

    var body: some View {
        switch screen {
        case "run":
            Pushed { WikiRunPage(run: ProbeData.bundle.runA) }
        case "revert":
            Pushed {
                // The alert `WikiRunView` puts over the page, in its words.
                WikiRunPage(run: ProbeData.bundle.runA)
                    .alert(WikiModeCopy.revertTitle, isPresented: .constant(true)) {
                        Button(WikiModeCopy.cancel, role: .cancel) {}
                        Button(WikiModeCopy.revertRunConfirm, role: .destructive) {}
                    } message: {
                        let summary = WikiModeLogic.runSummary(ProbeData.bundle.runA)
                        Text(WikiModeLogic.revertBody(summary) + "\n" + WikiModeCopy.revertKeeps)
                    }
            }
        case "entry-unreviewed":
            Pushed { WikiEntryPage(detail: ProbeData.bundle.unreviewed, now: ProbeData.now) }
        case "article":
            Pushed { WikiArticlePage(article: ProbeData.bundle.article, entries: ProbeData.bundle.article.entries) }
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
