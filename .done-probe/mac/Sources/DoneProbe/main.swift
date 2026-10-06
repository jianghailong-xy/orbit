import AppKit
import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../../../README.md). argv: <light|dark> <outDir>. Every card below is
// the app's own view (`ProjectDoneCards.swift`, copied in by run.sh) fed the same facts the iOS
// probe's stub serves; only the windows and the data are this file's.

enum Probe {
    static let appearance = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "light"
    static let outDir = URL(fileURLWithPath: CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "shots")

    static func log(_ line: String) {
        print("probe[\(appearance)]: \(line)")
        fflush(stdout)
    }

    static func iso(minutesAgo: Double) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: Date().addingTimeInterval(-minutesAgo * 60))
    }
}

// MARK: - the facts (the same as ../../stub.py's)

enum Fixture {
    static let ten = [
        "协调者用 project_request_start 请求开工，带计划与建议的运行方式",
        "开工前 Orbit 做 ready 检查：判据都有任务服务、任务都有 runner",
        "所有者在一张卡上确认判据并开工，设置一次写入",
        "web 的 Start this project? 卡与项目页的开工行",
        "iOS/macOS 同一张卡、同一套文案",
        "How it runs 区块：集成线、Automatic、并发与 merge check",
        "协调者请求后 Ready to start 写在会话行与项目列表",
        "开工后判据被改，卡片改问 Confirm the new criteria?",
        "project-start-request 的 pg spec 全绿",
        "上线：合入 main、部署、beta，所有者走查",
    ]

    static func criteria(_ texts: [String], _ base: Int) -> [ProjectDoneSubject.Criterion] {
        texts.enumerated().map { .init(id: "c\(base + $0.offset)", key: "c\(base + $0.offset)",
                                       ordinal: $0.offset + 1, text: $0.element) }
    }

    static func counts(_ answers: [ProjectDoneCriterion]) -> ProjectDoneCounts {
        var by: [CriterionLandingReason: Int] = [:]
        for a in answers { if let r = a.landingReason { by[r, default: 0] += 1 } }
        return ProjectDoneCounts(criteria: answers.count, met: answers.filter(\.satisfied).count,
                                 landed: answers.filter { $0.landing == "LANDED" }.count,
                                 onMain: answers.filter { $0.landingReason == nil }.count, byReason: by)
    }

    static func subject(_ title: String, status: String, _ items: [ProjectDoneSubject.Criterion],
                        _ answers: [ProjectDoneCriterion], doneBy: ProjectDoneBy? = nil,
                        doneAt: String? = nil, gaps: [AcceptedGap] = []) -> ProjectDoneSubject {
        let withheld = Array(Set(answers.flatMap(\.withheld))).sorted()
        return ProjectDoneSubject(
            title: title, status: status, criteria: items,
            derivedDone: ProjectDerivedDone(status: withheld.isEmpty ? "DONE" : "OPEN", done: withheld.isEmpty,
                                            withheld: withheld, criteria: answers,
                                            counts: counts(answers)),
            doneBy: doneBy, doneAt: doneAt, acceptedGaps: gaps)
    }

    static let askedItems = criteria(ten, 3000)
    static let gaps = [
        AcceptedGap(criterionKey: "c3009", title: "Go-live has nothing to land",
                    whyNotProven: "Its task made no commits — it checked the deploy, the release and ran the "
                        + "walkthrough — so there is no merge to hold a receipt for.",
                    coordinatorChecked: "main contains all 15 files this project added or changed",
                    evidenceRefs: ["34Y4xlxE"]),
        AcceptedGap(criterionKey: "c3009", title: "Shipped by other sessions",
                    whyNotProven: "The deploy (Sep 30 15:24) and beta.144 were cut by other sessions. This "
                        + "project made no runner release of its own — its runner change went out in 0.1.198.",
                    coordinatorChecked: "the live web has all 7 new strings · beta.144 TestFlight and DMG succeeded",
                    evidenceRefs: ["walkthrough log"]),
    ]
    static let asked = subject(
        "项目启动重做：协调者请求启动，一张卡定判据、集成分支与 Automatic", status: "OPEN", askedItems,
        askedItems.prefix(9).map { ProjectDoneCriterion(definitionId: $0.id, satisfied: true) }
            + [ProjectDoneCriterion(definitionId: "c3009", satisfied: true, landing: "UNKNOWN",
                                    landingReason: .nothingToLand, withheld: ["CRITERION_UNLANDED"])])
    static let request = DoneRequest(
        criteriaDigest: String(repeating: "c", count: 64),
        judgment: "The goal is met. All 10 criteria hold and the work is on main. Two things Orbit can’t "
            + "prove by itself — I checked both, below.",
        gaps: gaps)
    static let record = ProjectDoneRecord(projectId: "p", doneAt: Probe.iso(minutesAgo: 0.2),
                                          criteriaDigest: request.criteriaDigest, acceptedGaps: gaps,
                                          requestId: "item")

    static let workingItems = criteria([
        "web 与 iOS 的 Runner 页结构一一对应：引擎、账号、会话、更新四块同顺序。",
        "signed out 只在有工作区依赖本机登录时才提醒。",
        "上线：合入 main、部署、iOS/macOS 发一个 beta。",
        "web：项目页与项目列表写 Ready to start / How it runs。",
        "iOS/macOS：Runner 页与 web 同结构，文案逐字一致。",
    ], 3100)
    static let working = subject("Runner 页整页改版（iOS/macOS + web）", status: "OPEN", workingItems, [
        ProjectDoneCriterion(definitionId: "c3100", satisfied: true),
        ProjectDoneCriterion(definitionId: "c3101", satisfied: true),
        ProjectDoneCriterion(definitionId: "c3102", satisfied: true, landing: "UNKNOWN", landingReason: .noReceipt,
                             withheld: ["CRITERION_UNLANDED"]),
        ProjectDoneCriterion(definitionId: "c3103", satisfied: true, landing: "ON_INTEGRATION_LINE",
                             landingReason: .onProjectBranch, withheld: ["CRITERION_UNLANDED"]),
        ProjectDoneCriterion(definitionId: "c3104", satisfied: false, landing: "UNKNOWN", landingReason: .noReceipt,
                             withheld: ["CRITERION_UNSATISFIED", "CRITERION_UNLANDED"]),
    ])
    /// Recorded done by Orbit itself: what its coordinator conversation shows after a reload.
    static let orbitDoneItems = criteria(Array(ten.prefix(3)), 3400)
    static let orbitDone = subject("iOS 设置 sheet 改版", status: "DONE", orbitDoneItems,
                                   orbitDoneItems.map { ProjectDoneCriterion(definitionId: $0.id, satisfied: true) },
                                   doneBy: .derived, doneAt: "2026-09-30T18:12:00.000Z")
    static let landingItems = criteria(["证据先投协调者：投递与回执。", "协调者判完成的 MCP 工具与说明。",
                                        "web 决策条：协调者已判 / 等 owner。"], 3200)
    static let landing = subject("Automatic 项目里由协调者判任务完成", status: "OPEN", landingItems, [
        ProjectDoneCriterion(definitionId: "c3200", satisfied: true),
        ProjectDoneCriterion(definitionId: "c3201", satisfied: true),
        ProjectDoneCriterion(definitionId: "c3202", satisfied: true, landing: "ON_INTEGRATION_LINE",
                             landingReason: .inFlight, withheld: ["CRITERION_UNLANDED"]),
    ])
    static let doneRow = ProjectOpenItemRow(itemId: "item", kind: .unknown, title: ProjectDone.heading,
                                            waitingSince: Probe.iso(minutesAgo: 4), assignee: .owner,
                                            actions: [.review], doneRequest: request)

    /// The list rows the stub serves: the asked project, one nobody asked about, and two done ones.
    static let listRows: [ProjectSummary] = [
        ProjectSummary(id: "a", title: asked.title, createdAt: Probe.iso(minutesAgo: 5760), taskCount: 12,
                       buckets: ProjectBuckets(done: 11, failed: 0, cancelled: 1),
                       lastActivityAt: Probe.iso(minutesAgo: 4),
                       attention: ProjectListAttention(doneRequest: ProjectListDoneRequest(
                           waitingSince: Probe.iso(minutesAgo: 4))),
                       integration: ProjectListIntegration(line: .projectBranch, ref: "project/34Y7My8sq")),
        ProjectSummary(id: "w", title: working.title, createdAt: Probe.iso(minutesAgo: 5760), taskCount: 12,
                       buckets: ProjectBuckets(done: 11, failed: 0, cancelled: 1),
                       lastActivityAt: Probe.iso(minutesAgo: 30),
                       attention: ProjectListAttention(),
                       integration: ProjectListIntegration(line: .projectBranch, ref: "project/34Y7Work1")),
        ProjectSummary(id: "d", title: "项目进度改版：判据、落地与例外一页看全", status: .done,
                       createdAt: Probe.iso(minutesAgo: 5760), taskCount: 12,
                       buckets: ProjectBuckets(done: 11, failed: 0, cancelled: 1),
                       lastActivityAt: Probe.iso(minutesAgo: 4320), doneBy: .owner, acceptedGaps: gaps),
        ProjectSummary(id: "o", title: "iOS 设置 sheet 改版", status: .done,
                       createdAt: Probe.iso(minutesAgo: 5760), taskCount: 12,
                       buckets: ProjectBuckets(done: 11, failed: 0, cancelled: 1),
                       lastActivityAt: Probe.iso(minutesAgo: 5760), doneBy: .derived),
    ]
}


// MARK: - the windows

struct Shot {
    let name: String
    let size: CGSize
    let view: AnyView
}

enum Shots {
    /// The card as the conversation and the page both draw it now: whole, with no review target.
    /// Its open items are the console's own count over the stub's open-items read — the request
    /// alone, which is not one of them.
    static func card(_ subject: ProjectDoneSubject, request: DoneRequest?, record: ProjectDoneRecord?) -> ProjectDoneCard {
        let items = request == nil ? ProjectOpenItemsView() : ProjectOpenItemsView(doneRequest: Fixture.doneRow)
        return ProjectDoneCard(subject: subject, request: request,
                               askedAt: request == nil ? nil : Probe.iso(minutesAgo: 4),
                               confirmedAt: "2026-09-29T08:26:00.000Z",
                               openItems: ProjectDone.openItemsCount(items),
                               running: ProjectDone.runningCount(subject), record: record,
                               sealRead: true, onRecord: {}, onNotYet: request == nil ? nil : { _ in true },
                               onReopen: {})
    }

    static func page<V: View>(_ width: CGFloat, @ViewBuilder _ content: () -> V) -> AnyView {
        AnyView(ScrollView {
            VStack(alignment: .leading, spacing: 16) { content() }
                .padding(20)
                .frame(width: width, alignment: .leading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Color(nsColor: .windowBackgroundColor)))
    }

    static var all: [Shot] {
        [
            // The card in the coordinator conversation — and over the project page — whole, with its
            // two answers: no preview, no review.
            Shot(name: "m1-done-card", size: CGSize(width: 640, height: 1180),
                 view: page(600) { card(Fixture.asked, request: Fixture.request, record: nil) }),
            // The receipt a press leaves.
            Shot(name: "m4-receipt", size: CGSize(width: 640, height: 330),
                 view: page(600) { card(Fixture.asked, request: Fixture.request, record: Fixture.record) }),
            // Why is this project not done? — work nobody has, and a landing in flight.
            Shot(name: "m5-why-not-done-ask-coordinator", size: CGSize(width: 640, height: 560),
                 view: page(600) {
                     ProjectNotDoneCard(subject: Fixture.working, withCoordinator: 0, askedAt: nil,
                                        onAskCoordinator: {})
                 }),
            Shot(name: "m6-why-not-done-coordinator-is-on-it", size: CGSize(width: 640, height: 400),
                 view: page(600) {
                     ProjectNotDoneCard(subject: Fixture.landing, withCoordinator: 0, askedAt: nil)
                 }),
            // The project page's Open items: the coordinator's request — and, when nobody asked, the
            // owner's own row (never both at once).
            Shot(name: "m7-open-items-request-row", size: CGSize(width: 560, height: 230),
                 view: AnyView(List {
                     Section {
                         ProjectDoneRequestRow(row: Fixture.doneRow, now: Date(), onReview: {})
                     } header: {
                         Text(ProjectPage.needsYouGroup.uppercased()).font(.orbitMeta.weight(.semibold))
                     }
                 }
                 .listStyle(.inset))),
            Shot(name: "m7-open-items-own-row", size: CGSize(width: 560, height: 130),
                 view: AnyView(List {
                     Section {
                         ProjectOwnDoneRow(onRecord: {})
                     } header: {
                         Text(ProjectPage.needsYouGroup.uppercased()).font(.orbitMeta.weight(.semibold))
                     }
                 }
                 .listStyle(.inset))),
            // A card nobody asked for: Orbit fills in the gaps, and Record as done anyway.
            Shot(name: "m8-own-done-card", size: CGSize(width: 640, height: 900),
                 view: page(600) { card(Fixture.working, request: nil, record: nil) }),
            // A DONE Orbit recorded itself: the Why-not-done card's terminal state.
            Shot(name: "m10-orbit-done-terminal-state", size: CGSize(width: 640, height: 200),
                 view: page(600) {
                     ProjectNotDoneCard(subject: Fixture.orbitDone, withCoordinator: 0, askedAt: nil)
                 }),
            // The projects list: Needs you · Ready to close · 4m while the coordinator asks, and who
            // recorded a done project — the app's own `ProjectRow`.
            Shot(name: "m9-projects-list", size: CGSize(width: 560, height: 420),
                 view: AnyView(List {
                     Section {
                         ForEach(Fixture.listRows, id: \.id) { ProjectRow(project: $0, now: Date()) }
                     } header: {
                         Text(ProjectAttentionSection.attention.title).font(.orbitMeta.weight(.semibold))
                     }
                 }
                 .listStyle(.inset))),
        ]
    }
}


final class ProbeDelegate: NSObject, NSApplicationDelegate {
    private var windows: [NSWindow] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.appearance = NSAppearance(named: Probe.appearance == "dark" ? .darkAqua : .aqua)
        var origin = CGPoint(x: 40, y: 40)
        for shot in Shots.all {
            let host = NSHostingController(rootView: shot.view)
            let window = NSWindow(contentViewController: host)
            window.title = shot.name
            window.styleMask = [.titled, .closable, .resizable]
            window.setContentSize(shot.size)
            window.setFrameOrigin(origin)
            window.makeKeyAndOrderFront(nil)
            windows.append(window)
            origin.x += 30
            origin.y += 30
        }
        NSApp.activate(ignoringOtherApps: true)
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            for (shot, window) in zip(Shots.all, self.windows) {
                // Key and active, as a window being read is: an inactive window draws its prominent
                // buttons grey.
                NSApp.activate(ignoringOtherApps: true)
                window.makeKeyAndOrderFront(nil)
                window.orderFrontRegardless()
                try? await Task.sleep(nanoseconds: 1_200_000_000)
                Probe.log("\(shot.name): key=\(window.isKeyWindow) active=\(NSApp.isActive)")
                Capture.save(window, as: "\(shot.name)-\(Probe.appearance)")
            }
            NSApp.terminate(nil)
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 90) {
            Probe.log("timed out")
            exit(3)
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = ProbeDelegate()
app.delegate = delegate
app.run()

@MainActor
enum Capture {
    /// One window, two ways: the window server's own copy of it, and AppKit drawing its content view
    /// into a bitmap (kept as a fallback).
    static func save(_ window: NSWindow, as name: String) {
        // kCGWindowListOptionIncludingWindow, kCGWindowImageBoundsIgnoreFraming
        if let image = windowImage(option: 1 << 3, window: window.windowNumber, imageOption: 1) {
            write(NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]), "\(name).png")
        } else if let view = window.contentView,
                  let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
            view.cacheDisplay(in: view.bounds, to: rep)
            write(rep.representation(using: .png, properties: [:]), "\(name).cache.png")
        }
    }

    private typealias CreateImage = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?

    /// CGWindowListCreateImage, looked up at run time: the SDK no longer declares it, but the system
    /// still ships it, and the caller's own windows need no grant.
    private static func windowImage(option: UInt32, window: Int, imageOption: UInt32) -> CGImage? {
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage") else {
            Probe.log("CGWindowListCreateImage is not there")
            return nil
        }
        let create = unsafeBitCast(symbol, to: CreateImage.self)
        return create(CGRect.null, option, UInt32(window), imageOption)?.takeRetainedValue()
    }

    private static func write(_ png: Data?, _ file: String) {
        guard let png else {
            Probe.log("no PNG for \(file)")
            return
        }
        do {
            try png.write(to: Probe.outDir.appendingPathComponent(file))
            Probe.log("wrote \(file) (\(png.count) bytes)")
        } catch {
            Probe.log("\(file): \(error)")
        }
    }
}
