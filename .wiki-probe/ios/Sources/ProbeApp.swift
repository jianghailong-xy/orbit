import SwiftUI
import UIKit
import OrbitKit

// TEMPORARY evidence probe (see ../../README.md). One screen per launch (`-screen <name>`), drawn by the
// app's own pages — Generated/WikiView.swift and Generated/WikiArticleView.swift copied whole — over
// ProbeData.json: the demo site's real articles and entries, the rows the web screenshots show.

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
    let directory: WikiArticleDirectory
    let article: WikiArticle
    let topicEntries: [WikiEntry]
    let index: [WikiArticleIndex.Item]
    let footnote7: WikiArticleFootnote
    let detail7: WikiEntryDetail
}

enum ProbeData {
    static let bundle: ProbeBundle = {
        let url = Bundle.main.url(forResource: "ProbeData", withExtension: "json")!
        return try! JSONDecoder().decode(ProbeBundle.self, from: Data(contentsOf: url))
    }()
    static let now = RelativeTime.parse(bundle.now)!
    static var home: WikiHomeContent {
        WikiHomeContent(space: bundle.space, spaces: [bundle.space], entries: bundle.entries,
                        timeline: bundle.timeline, proposals: 12)
    }
    static var groups: [WikiArticleLogic.DirectoryGroup] { WikiArticleLogic.directoryGroups(bundle.directory) }
}

struct ProbeRoot: View {
    private var screen: String {
        let args = ProcessInfo.processInfo.arguments
        guard let at = args.firstIndex(of: "-screen"), at + 1 < args.count else { return "home" }
        return args[at + 1]
    }

    var body: some View {
        switch screen {
        case "contents":
            homePage.sheet(isPresented: .constant(true)) {
                WikiContentsSheet(groups: ProbeData.groups, at: .home) { _ in }
            }
        case "contents-article":
            Pushed { article }
                .sheet(isPresented: .constant(true)) {
                    WikiContentsSheet(groups: ProbeData.groups, at: .article(topic: "ui-design", part: 1)) { _ in }
                }
        case "article":
            Pushed { article }
        case "article-card":
            // The card a footnote's press opens, over the page, as `WikiArticlePage` presents it.
            Pushed {
                article.sheet(isPresented: .constant(true)) {
                    WikiFootnoteCard(footnote: ProbeData.bundle.footnote7, detail: ProbeData.bundle.detail7) { _ in }
                        .presentationDetents([.medium])
                }
            }
        case "browse":
            Pushed { WikiBrowsePage(categories: WikiArticleLogic.browseCategories(ProbeData.bundle.directory)) }
        case "index":
            Pushed {
                WikiIndexPage(groups: WikiArticleLogic.indexGroups(ProbeData.bundle.index), count: ProbeData.bundle.index.count)
            }
        default:
            homePage
        }
    }

    private var homePage: some View {
        NavigationStack {
            WikiHomePage(content: ProbeData.home, now: ProbeData.now)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Image(systemName: "line.3.horizontal").accessibilityLabel("Open navigation")
                    }
                }
        }
    }

    private var article: some View {
        WikiArticlePage(article: ProbeData.bundle.article, entries: ProbeData.bundle.topicEntries,
                        detail: { id in id == ProbeData.bundle.detail7.entry.id ? ProbeData.bundle.detail7 : nil })
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
