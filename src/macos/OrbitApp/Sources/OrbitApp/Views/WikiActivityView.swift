import SwiftUI
import OrbitKit

// Activity (design §12.3.2, mock 31 ②): what the Wiki home says besides its content — the status line,
// what waits on the owner, the decisions, the changes and the agents' use — in the home's order, which
// `WikiLogic.ActivityBand` holds to the web's `WikiActivityPage.tsx`. Its bar is Review's: back, the title
// and the space's name under it. The screen reads `AppModel.wiki` and decides where a press goes; the page
// draws what it is given.

/// Where a press on Activity goes.
struct WikiActivityActions {
    var openEntry: (String) -> Void = { _ in }
    var openRun: (String) -> Void = { _ in }
    /// A banner: Review over every space, a space's plan page, or its Wiki settings.
    var openBanner: (WikiSpaceLogic.ActivityBanner) -> Void = { _ in }
    /// The status line's Set up and View run.
    var openSettings: () -> Void = {}
    var openSession: (String) -> Void = { _ in }
}

/// Activity's page: the status line; the banners — every space's proposals, the space's plan, the plans of
/// the other spaces that wait on the owner; then Recent decisions, Recently changed with what came after the
/// reader last looked, and Agents used the wiki.
struct WikiActivityPage: View {
    let content: WikiHomeContent
    /// The space's name, under the title.
    let spaceName: String
    let banners: [WikiSpaceLogic.ActivityBanner]
    /// When the reader last looked (`WikiSeenLog`): nil until it is read, and nothing is marked before then.
    var seen: Double? = nil
    var now: Date = Date()
    var actions = WikiActivityActions()

    var body: some View {
        List {
            ForEach(WikiLogic.ActivityBand.allCases, id: \.self) { band in
                self.band(band)
            }
        }
        .listStyle(.plain)
        .navigationTitle(WikiCopy.activity)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .principal) { titleBlock }
        }
    }

    /// "Activity" over the space's name, as Review's bar carries its own title and line.
    private var titleBlock: some View {
        VStack(spacing: 1) {
            Text(WikiCopy.activity).font(.headline)
            Text(spaceName).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        }
    }

    private var rows: WikiBandRows {
        WikiBandRows(content: content, now: now,
                     actions: WikiBandActions(openEntry: actions.openEntry, openRun: actions.openRun))
    }

    @ViewBuilder
    private func band(_ band: WikiLogic.ActivityBand) -> some View {
        switch band {
        case .status:
            statusLine
                .listRowSeparator(.hidden)
        case .reviewBanner, .planBanners, .otherPlanBanners:
            ForEach(banners.filter { $0.band == band }) { banner in
                WikiActivityBannerRow(banner: banner) { actions.openBanner(banner) }
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
            }
        case .recentDecisions:
            Section {
                rows.bandHeader(WikiCopy.recentDecisions, count: content.recentDecisions.count)
                if content.recentDecisions.isEmpty {
                    rows.empty(WikiCopy.noDecisions)
                } else {
                    ForEach(content.recentDecisions) { entry in rows.decisionRow(entry) }
                }
            }
        case .recentlyChanged:
            Section {
                rows.bandHeader(WikiCopy.recentlyChanged, new: newRows > 0 ? WikiCopy.newSinceLastLooked(newRows) : nil)
                if content.recentlyChanged.isEmpty {
                    rows.empty(WikiCopy.noChanges)
                } else {
                    // One run is one row, by the changeset its items name; a row after the stamp wears the blue dot.
                    ForEach(content.recentRows) { row in
                        switch row {
                        case .op(let item):
                            rows.changeRow(item, new: isNew(item.at))
                        case .run(let changesetId, let origin, let at, let items):
                            rows.runRow(changesetId, origin: origin, at: at, changes: items.count, new: isNew(at))
                        }
                    }
                }
            }
        case .agentsUsed:
            Section {
                rows.bandHeader(WikiCopy.agentsUsed, hint: WikiCopy.agentsUsedHint)
                rows.usage
            }
        }
    }

    /// How many rows came after the reader last looked: none before the stamp is read.
    private var newRows: Int { seen.map { content.newRows(seen: $0) } ?? 0 }

    /// A row's dot, blue or grey — none before the stamp is read.
    private func isNew(_ at: String?) -> Bool? { seen.map { WikiSeenLog.isNew(at, seen: $0) } }

    /// The status line under the bar (mock 31 ②): what the space holds, the commit its anchors were
    /// verified at and where maintenance stands, with Set up and View run as links — the home's line.
    private var statusLine: some View {
        Text(wikiStatusText(content.statusParts(now: now)))
            .font(.orbitLabel)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .environment(\.openURL, OpenURLAction { url in
                switch url {
                case wikiStatusSettingsURL:
                    actions.openSettings()
                case wikiStatusRunURL:
                    if let session = content.health?.maintenance.lastRun?.sessionId { actions.openSession(session) }
                default:
                    return .systemAction
                }
                return .handled
            })
    }
}

/// One of Activity's banners, in the needs-you bar's shape: the amber wash and dot for what waits on the
/// owner, the blue for what the plan is doing; the words in the label colour and a chevron, the whole bar
/// one press.
private struct WikiActivityBannerRow: View {
    let banner: WikiSpaceLogic.ActivityBanner
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 9) {
                Circle()
                    .fill(banner.tone == .amber ? Color.orange : Color.blue)
                    .frame(width: 7, height: 7)
                Text(banner.text)
                    .font(.orbitControl)
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Image(systemName: "chevron.forward")
                    .font(.orbitMeta)
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(banner.tone == .amber ? AnyShapeStyle(wikiAmberWash) : AnyShapeStyle(Color.blue.opacity(0.10)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(banner.text)
    }
}

/// Activity over the model: the home's reads for the space on screen, its plan and the documents its blue
/// banner counts, and the plans of the other spaces where something waits — and when the reader last
/// looked, read as the page opens from before the home moved it, then moved to now.
struct WikiActivityView: View {
    @Environment(AppModel.self) private var model

    @State private var seen: Double?

    var body: some View {
        if let wiki = model.wiki {
            TimelineView(.periodic(from: .now, by: 60)) { context in
                if let home = wiki.home, let space = wiki.currentSpace {
                    WikiActivityPage(content: home, spaceName: name(of: space, in: wiki),
                                     banners: banners(wiki, space: space, now: context.date),
                                     seen: seen, now: context.date, actions: actions(wiki))
                } else {
                    WikiHomePlaceholder(wiki: wiki)
                }
            }
            .task(id: wiki.currentSpace?.slug) {
                if let slug = wiki.currentSpace?.slug {
                    seen = wiki.seenBefore(slug)
                    wiki.moveSeen(slug)
                }
                if wiki.home == nil || wiki.home?.space.id != wiki.currentSpace?.id { await wiki.loadHome() }
                await wiki.loadPlan()
                await wiki.loadDocsDirectory()
                await wiki.loadOtherPlans()
            }
            .refreshable {
                await wiki.loadHome()
                await wiki.loadPlan()
                await wiki.loadOtherPlans()
            }
        } else {
            ProgressView()
        }
    }

    /// The space's name as the reader knows it (design §12.3.4).
    private func name(of space: WikiSpace, in wiki: WikiModel) -> String {
        WikiSpaceLogic.names(wiki.spaces)[space.id] ?? space.title ?? space.slug
    }

    /// What waits on the owner across every space, and what the space's plan is doing — the drawer's number,
    /// banner by banner.
    private func banners(_ wiki: WikiModel, space: WikiSpace, now: Date) -> [WikiSpaceLogic.ActivityBanner] {
        var plans = wiki.otherPlans
        if let plan = wiki.plan { plans[space.id] = plan }
        let docs = wiki.docsDirectory.flatMap { directory in
            directory.plan != nil ? directory.docs.map { (written: $0.written, total: $0.total) } : nil
        }
        return WikiSpaceLogic.activityBanners(spaces: wiki.spaces, current: space, plans: plans, now: now, docs: docs,
                                              runnerOnline: { model.wikiMaintenanceRunnerOnline(of: $0) })
    }

    private func actions(_ wiki: WikiModel) -> WikiActivityActions {
        WikiActivityActions(
            openEntry: { id in model.push(.wikiEntry(entryID: id)) },
            openRun: { id in model.push(.wikiRun(changesetID: id)) },
            openBanner: { banner in open(banner.to, wiki) },
            openSettings: { model.push(.wikiSettings) },
            openSession: { id in model.openFromConversation(.session(PublicID.toPublic(id)), overConsole: false) })
    }

    /// A banner's way: Review over every space; or a space's plan, or its settings — another space's first
    /// becoming the one on screen, as the web's link to its page does.
    private func open(_ to: WikiSpaceLogic.ActivityBanner.To, _ wiki: WikiModel) {
        switch to {
        case .review:
            model.push(.wikiReview)
        case .plan(let slug), .settings(let slug):
            if wiki.currentSpace?.slug != slug {
                wiki.selectedSlug = slug
                Task { await wiki.loadHome() }
            }
            if case .settings = to { model.push(.wikiSettings) } else { model.push(.wikiPlan(version: nil)) }
        }
    }
}
