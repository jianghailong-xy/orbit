import Foundation

// The spaces as a reader knows them (design §12.3.3–§12.3.4): what each is called, which one the Wiki
// opens, and how much waits on the owner across all of them — the Swift half of the web's
// `src/web/src/lib/wikiSpace.ts`.
//
// RULES OVER THE SPACES LIST (`GET /wiki/spaces`), not over a page, because the two clients are held to
// one set of cases: `src/shared/src/wiki-space.fixture.json`, which `WikiSpaceLogicTests` reads where the
// web's `wikiSpace.test.ts` reads it.
//
// Pure, with no SwiftUI, so it is tested on Linux like the rest of this directory.

public enum WikiSpaceLogic {
    // MARK: the name

    /// What each space is called, by id (`wikiSpaceNames`): the last segment of its repository
    /// (`github.com/jianghailong-xy/orbit` is `orbit`), its title when it has no repository, and — when
    /// two spaces would be called the same — the segments before it until the two differ
    /// (`jianghailong-xy/orbit`).
    public static func names(_ spaces: [WikiSpace]) -> [String: String] {
        var segments: [String: [String]] = [:]
        var depth: [String: Int] = [:]
        for space in spaces {
            segments[space.id] = (space.repoUrlNorm ?? "").split(separator: "/").map(String.init)
            depth[space.id] = 1
        }
        func name(_ space: WikiSpace) -> String {
            let parts = segments[space.id] ?? []
            return parts.isEmpty ? space.title ?? space.slug : parts.suffix(depth[space.id] ?? 1).joined(separator: "/")
        }
        while true {
            var named: [String: [WikiSpace]] = [:]
            for space in spaces { named[name(space), default: []].append(space) }
            let longer = named.values.filter { $0.count > 1 }.joined()
                .filter { (depth[$0.id] ?? 1) < (segments[$0.id]?.count ?? 0) }
            if longer.isEmpty { break }
            for space in longer { depth[space.id, default: 1] += 1 }
        }
        var out: [String: String] = [:]
        for space in spaces { out[space.id] = name(space) }
        return out
    }

    // MARK: which space the Wiki opens

    /// The space the Wiki opens (`wikiDefaultSpace`): the one bound to the workspace the reader is in
    /// (`workspaceIds`), else the one they last looked at, else the one with the most documents written —
    /// the first of the server's list when that is a tie. Nil with no space.
    public static func defaultSpace(_ spaces: [WikiSpace], workspaceID: String?, lastSlug: String?) -> WikiSpace? {
        if let workspaceID {
            let key = PublicID.storageKey(workspaceID)
            if let bound = spaces.first(where: { ($0.workspaceIds ?? []).contains { PublicID.storageKey($0) == key } }) {
                return bound
            }
        }
        if let lastSlug, let last = spaces.first(where: { $0.slug == lastSlug }) { return last }
        var most: WikiSpace?
        for space in spaces where most == nil || (space.docs?.written ?? 0) > (most?.docs?.written ?? 0) {
            most = space
        }
        return most
    }

    /// Where the reader is when they open the Wiki (design §12.3.4): the workspace whose session list is
    /// showing, or — on a project's page or its sessions page — the workspace the project's coordinator
    /// runs in (nil while that is not known); nowhere on a page that is neither, the Projects or Tasks list,
    /// which leaves the choice to the space last looked at. The web's sidebar keeps the same for its tab
    /// (`writeWikiFromWorkspace`).
    public static func workspaceInView(_ nav: NavState, agentID: String?,
                                       coordinatorWorkspace: (String) -> String?) -> String? {
        switch nav.section {
        case .agents:
            switch nav.drawerDestination(agentID: agentID) {
            case .workspace(let id):      return id
            case .project(let projectID): return coordinatorWorkspace(projectID)
            case .section:                return nil
            }
        case .projects:
            return nav.selectedProjectID.flatMap(coordinatorWorkspace)
        default:
            return nil
        }
    }

    // MARK: what waits on the owner

    /// What waits on the owner in one space (`wikiWaitingIn`): its proposals in Review and the things its
    /// plan waits on them for. A count an older server did not send adds nothing.
    public static func waitingIn(_ space: WikiSpace) -> Int {
        max(0, space.pendingOps ?? 0) + max(0, space.planWaiting ?? 0)
    }

    /// What waits on the owner across every space (`wikiWaiting`, §12.3.3): the drawer's Wiki row — the
    /// iPad sidebar's too — and the bar's Activity badge, both from here, and what Activity's amber banners
    /// add up to.
    public static func waiting(_ spaces: [WikiSpace]) -> Int {
        spaces.reduce(0) { $0 + waitingIn($1) }
    }

    /// The proposals alone, across every space (`wikiProposalsWaiting`): Activity's first banner, and
    /// Review's head, which counts the same queue.
    public static func proposalsWaiting(_ spaces: [WikiSpace]) -> Int {
        spaces.reduce(0) { $0 + max(0, $1.pendingOps ?? 0) }
    }

    /// Activity's first banner (`wikiProposalsBanner`, mock 31 ⑤): every space's proposals, with each other
    /// space's share on the same line — `3 proposals to review · 2 in wikova` — and nothing after the count
    /// when they are all the current space's. Nil with none waiting anywhere.
    public static func proposalsBanner(_ spaces: [WikiSpace], current currentID: String?,
                                       names: [String: String]? = nil) -> String? {
        let total = proposalsWaiting(spaces)
        guard total > 0 else { return nil }
        let names = names ?? self.names(spaces)
        let elsewhere = spaces
            .filter { $0.id != currentID && ($0.pendingOps ?? 0) > 0 }
            .map { WikiCopy.countInSpace($0.pendingOps ?? 0, names[$0.id] ?? $0.title ?? $0.slug) }
        return ([WikiCopy.proposalsToReview(total)] + elsewhere).joined(separator: " ")
    }

    /// A space as the web's picker lists it (`wikiSpaceOption`, mock 31 ④): its name, and what waits in it
    /// when anything does — `wikova · 2 waiting`.
    public static func option(_ name: String, _ space: WikiSpace) -> String {
        let waiting = waitingIn(space)
        return waiting > 0 ? "\(name) \(WikiCopy.spaceWaiting(waiting))" : name
    }

    // MARK: Activity's banners

    /// One of Activity's banners (mocks 31 ②, ⑤): its line, its colour, how many of the number waiting on
    /// the owner it is — none for a blue one — and where a press goes.
    public struct ActivityBanner: Equatable, Sendable, Identifiable {
        public enum To: Equatable, Sendable {
            /// Review, over every space.
            case review
            /// A space's plan page.
            case plan(slug: String)
            /// A space's Wiki settings: a plan held for want of a setting.
            case settings(slug: String)
        }

        public let id: String
        /// The band it stands in: the proposals', the space's plan, or another space's plan.
        public let band: WikiLogic.ActivityBand
        public let text: String
        public let tone: WikiPlanLogic.Banner.Tone
        public let count: Int
        public let to: To
    }

    /// Activity's banners, in its order (`WikiActivityPage.tsx`): every space's proposals, each other
    /// space's share on the line (`proposalsBanner`), into Review over every space; then the space's plan,
    /// one banner for each kind of thing that waits (`WikiPlanLogic.waitingBanners`) — or, with nothing
    /// waiting, the plan's blue banner as the home draws it; then the plans of the other spaces where
    /// something waits (`planWaiting`), only what waits, each saying which space.
    ///
    /// The amber banners' counts add up to `waiting(spaces)` — the drawer's number and the Activity badge's —
    /// as long as each plan read counts what the server's `planWaiting` counts, which is the one rule. A
    /// space's plan is in `plans` by the space's id; one not read draws nothing.
    public static func activityBanners(spaces: [WikiSpace], current: WikiSpace, plans: [String: WikiPlanState],
                                       now: Date, docs: (written: Int, total: Int)?,
                                       runnerOnline: (WikiSpace) -> Bool?) -> [ActivityBanner] {
        let names = self.names(spaces)
        var banners: [ActivityBanner] = []
        if let text = proposalsBanner(spaces, current: current.id, names: names) {
            banners.append(ActivityBanner(id: "review", band: .reviewBanner, text: text, tone: .amber,
                                          count: proposalsWaiting(spaces), to: .review))
        }
        func plan(_ banner: WikiPlanLogic.Banner, look: WikiPlanLogic.Look, count: Int, space: WikiSpace,
                  band: WikiLogic.ActivityBand, text: String) -> ActivityBanner {
            ActivityBanner(id: "\(band.rawValue):\(space.id):\(look.rawValue)", band: band, text: text, tone: banner.tone,
                           count: banner.tone == .amber ? count : 0,
                           to: banner.to == .settings ? .settings(slug: space.slug) : .plan(slug: space.slug))
        }
        let online = runnerOnline(current)
        if let state = plans[current.id], let look = WikiPlanLogic.look(state, runnerOnline: online) {
            let waiting = WikiPlanLogic.waitingBanners(state, now: now, docs: docs, runnerOnline: online)
            if waiting.isEmpty {
                let banner = WikiPlanLogic.banner(look, state: state, now: now, docs: docs, runnerOnline: online)
                banners.append(plan(banner, look: look, count: 0, space: current, band: .planBanners, text: banner.text))
            }
            for one in waiting {
                banners.append(plan(one.banner, look: one.look, count: one.count, space: current, band: .planBanners,
                                    text: one.banner.text))
            }
        }
        for space in spaces where space.id != current.id && (space.planWaiting ?? 0) > 0 {
            guard let state = plans[space.id] else { continue }
            let name = names[space.id] ?? space.title ?? space.slug
            for one in WikiPlanLogic.waitingBanners(state, now: now, docs: nil, runnerOnline: runnerOnline(space)) {
                banners.append(plan(one.banner, look: one.look, count: one.count, space: space, band: .otherPlanBanners,
                                    text: "\(one.banner.text) \(WikiCopy.inSpace(name))"))
            }
        }
        return banners
    }

    // MARK: the native picker

    /// One space as the native picker draws it (design §12.3.4, mock 31 ④): a system menu's row has a
    /// title, a subtitle and an icon. The name is the title; the repository and the documents are the
    /// subtitle, a line each; what waits is the amber number in the icon cell (`N.circle.fill`), and where
    /// a menu cannot draw it amber, the subtitle ends with the web option's `· N waiting` instead.
    public struct MenuRow: Equatable, Sendable, Identifiable {
        public let id: String
        public let slug: String
        public let name: String
        /// The repository, when the space has one, then its documents (`35 documents`, `No documents yet`).
        public let lines: [String]
        public let waiting: Int

        /// The SF Symbol of the number in the icon cell: the numbered circles stop at 50.
        public var waitingSymbol: String? {
            waiting > 0 && waiting <= 50 ? "\(waiting).circle.fill" : nil
        }

        /// The subtitle, one line under another; with `sayWaiting` — no amber icon to carry it — the last
        /// line ends with `· N waiting`.
        public func subtitle(sayWaiting: Bool) -> String {
            var lines = self.lines
            if sayWaiting && waiting > 0, let last = lines.popLast() {
                lines.append("\(last) \(WikiCopy.spaceWaiting(waiting))")
            }
            return lines.joined(separator: "\n")
        }
    }

    /// Every space's row, in the server's order.
    public static func menuRows(_ spaces: [WikiSpace], names: [String: String]? = nil) -> [MenuRow] {
        let names = names ?? self.names(spaces)
        return spaces.map { space in
            let documents = space.docs.map { WikiCopy.documentCount($0.total) } ?? WikiCopy.noDocuments
            let repository = space.repoUrlNorm.flatMap { $0.isEmpty ? nil : $0 }
            return MenuRow(id: space.id, slug: space.slug, name: names[space.id] ?? space.title ?? space.slug,
                           lines: [repository, documents].compactMap { $0 }, waiting: waitingIn(space))
        }
    }
}

// MARK: - since the reader last looked

/// When the reader last looked at a space (design §12.3.2): the web's `wikiSeenKey(space, 'home')` stamp,
/// which the app keeps in UserDefaults rather than a browser's storage, read and moved by the web's rule
/// (`moveWikiSeen`, `readWikiSeenBefore`).
///
/// Two pages read the one stamp: the home moves it as it opens, and Activity — which a reader reaches from
/// the home — marks what changed since the reader last looked. Read after the home moved it, the stamp
/// would say "just now" and Activity would mark nothing, so a move keeps what the stamp said before, for
/// the next page of the same visit. A second move within a second of the first is the same page opening
/// again and keeps what the stamp said before the first.
///
/// The stamps themselves are the caller's to store (`stored` in, the moved time out): this holds only what
/// each said before this run of the app last moved it, as the web's tab does.
public struct WikiSeenLog: Equatable, Sendable {
    private var before: [String: Double] = [:]
    private var movedAt: [String: Double] = [:]

    public init() {}

    /// Where a space's stamp is kept: one per space, as the web keeps one per space in a browser.
    public static func key(space slug: String, scope: String = "home") -> String {
        "orbit.wiki.seen.\(slug).\(scope)"
    }

    /// The stamp moves to `at` (seconds since 1970) from `stored`, what it says now — 0 for never.
    public mutating func move(_ key: String, at: Double, stored: Double) {
        if let last = movedAt[key], at - last < 1 {
            // The same page opening again: what it said before the first move stays the answer.
        } else {
            before[key] = stored
        }
        movedAt[key] = at
    }

    /// The stamp as it stood before this run last moved it — or as it stands (`stored`), when it has not.
    public func seenBefore(_ key: String, stored: Double) -> Double {
        before[key] ?? stored
    }

    /// Whether something that happened `at` came after the reader last looked (`seen`; 0 is never): a row
    /// of Activity's Recently changed that wears the blue dot. Nothing seen before means everything is new.
    public static func isNew(_ at: String?, seen: Double) -> Bool {
        guard seen > 0 else { return true }
        guard let at, let date = RelativeTime.parse(at) else { return false }
        return date.timeIntervalSince1970 > seen
    }
}
