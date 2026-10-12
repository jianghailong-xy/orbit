import SwiftUI
import OrbitKit

// The Wiki's middle column on the three-column shells — the iPad's and the Mac's (design §12.3, mock 32): the
// directory as a column, the very rows a phone's Contents sheet lists (`WikiContentsRows`) — Home, Browse by
// category, the A–Z index and the Plan, then the confirmed plan's categories and documents, or before a plan
// every category's topic articles — under `Wiki` and the space. A row puts its page in the detail pane beside
// it, the home at the stack's root, and the row of the page on show is lit (`NavState.wikiContentsAt`): none
// while Activity, Review or the settings are, which open in the detail pane from the home's bar.

/// The directory column, over the model's reads.
struct WikiContentsColumn: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let wiki = model.wiki {
            // A space with a confirmed plan reads by its documents; before one, by its topic articles.
            let docGroups = WikiDocLogic.readsByDocs(wiki.docsDirectory) ? wiki.docsDirectory.map(WikiDocLogic.directoryGroups) ?? [] : []
            List {
                if let space = wiki.currentSpace {
                    head(space, wiki)
                }
                WikiContentsRows(groups: docGroups.isEmpty ? wiki.directory.map(WikiArticleLogic.directoryGroups) ?? [] : [],
                                 at: model.nav.wikiContentsAt, docGroups: docGroups,
                                 planPending: wiki.plan.map { WikiPlanLogic.pending($0, runnerOnline: model.wikiMaintenanceRunnerOnline) } ?? 0,
                                 pick: select)
            }
            .listStyle(.plain)
            .navigationTitle("")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .task(id: wiki.currentSpace?.slug) {
                await wiki.loadDocsDirectory()
                await wiki.loadDirectory()
                await wiki.loadPlan()
            }
        } else {
            ProgressView()
        }
    }

    /// `Wiki` and the space it is about, as the phone's home heads its page: a label with one space, a picker
    /// among several (design §12.3.4). Another space starts at its home.
    private func head(_ space: WikiSpace, _ wiki: WikiModel) -> some View {
        HStack(spacing: 10) {
            Text(WikiCopy.title)
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
            WikiSpacePicker(space: space, spaces: wiki.spaces,
                            pick: { slug in
                                model.nav.popToRoot()
                                wiki.selectedSlug = slug
                            },
                            manage: { open(.wikiSettings) })
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .listRowSeparator(.hidden)
    }

    /// A row's page into the detail pane, in place of whatever was there, the pages opened over it included: the
    /// home is the stack's root, every other page the one frame above it.
    private func select(_ pick: WikiContentsPick) {
        switch pick {
        case .home:                         model.nav.popToRoot()
        case .browse:                       open(.wikiBrowse)
        case .index:                        open(.wikiIndex)
        case .plan:                         open(.wikiPlan(version: nil))
        case .article(let topic, let part): open(.wikiArticle(topic: topic, part: part))
        case .doc(let slug, let section):   open(.wikiDoc(slug: slug, section: section))
        }
    }

    private func open(_ node: NavNode) {
        model.nav.popToRoot()
        model.push(node)
    }
}
