import SwiftUI
import OrbitKit

// Scheduled tasks' cards (docs/mocks/scheduled-tasks/02-agent-first.png ① ② ④ ⑤, 01-board.png ④ ⑤ ⑦): the create
// card and the envelope card a conversation asks, the line a change leaves where it was made, a run's strip and
// report in its own session, and the four Waiting on you cards. Drawn the same in every conversation, so on the Mac
// too; the words and rules are OrbitKit's (`ScheduleCopy`, `ScheduleDisplay`), and the web's cards
// (`ScheduleCards.tsx`, `ScheduleWaitingCard.tsx`) behave the same: a decided card stays, without its buttons; a
// withdrawn one says so and is never pressed again.

private typealias SC = ScheduleCopy

/// The boards' blue for the schedule cards' primary press and links.
extension Color {
    static let scheduleAccent = Color.accentColor
    static let scheduleWarn = Color.orange
}

/// One fact row of a card: a grey label column and its value (board ① "When / Runs in / May / Costs / Today").
struct ScheduleFactRow<Value: View>: View {
    let label: String
    /// The label column; wider on a card whose labels are longer ("Starts when", board frame 2).
    var labelWidth: CGFloat = 72
    @ViewBuilder let value: Value

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label)
                .foregroundStyle(.secondary)
                .frame(width: labelWidth, alignment: .leading)
            value
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.orbitSubtext)
    }
}

/// "Check only · reads and reports, edits nothing", the label in bold.
func scheduleMayText(_ level: String) -> Text {
    let access = ScheduleDisplay.accessCopy(level)
    return Text(access.label).bold() + Text("\(SC.separator)\(access.detail)")
}

/// "Up to 7 runs a week, 30 min each", the runs in bold.
func scheduleCostsText(runsPerWeek: Int, runLimitMinutes: Int) -> Text {
    let parts = ScheduleDisplay.costsParts(runsPerWeek: runsPerWeek, runLimitMinutes: runLimitMinutes)
    return Text(parts.before) + Text(parts.emphasis).bold() + Text(parts.after)
}

/// The two buttons that end a card, side by side across its foot (board ①: Not now · Create).
struct ScheduleCardFoot: View {
    let decline: String
    let allow: String
    let busy: Bool
    let onDecline: () -> Void
    let onAllow: () -> Void
    var idPrefix: String

    var body: some View {
        HStack(spacing: 0) {
            Button(action: onDecline) {
                Text(decline).font(.orbitControl.weight(.medium)).frame(maxWidth: .infinity).padding(.vertical, 11)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.scheduleAccent)
            .accessibilityIdentifier("\(idPrefix)-decline")
            Button(action: onAllow) {
                Text(allow).font(.orbitControl.weight(.semibold)).frame(maxWidth: .infinity).padding(.vertical, 11)
                    .foregroundStyle(.white)
                    .background(Color.scheduleAccent)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("\(idPrefix)-allow")
        }
        .disabled(busy)
        .opacity(busy ? 0.6 : 1)
        .overlay(alignment: .top) { Divider() }
    }
}

/// The card chrome: a rounded box, a hairline border (amber for a card about growing what a schedule may do).
private struct ScheduleCardBox: ViewModifier {
    var warn = false
    func body(content: Content) -> some View {
        content
            .background(Color.secondary.opacity(0.04), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(warn ? Color.scheduleWarn.opacity(0.6) : Color.secondary.opacity(0.25)))
    }
}

/// The create card (board 02 ①): the title, the read-back, When, Runs in, May, Costs and Today, then Not now and
/// Create. Create on a card that names no zone sends this device's. `panel` puts the first run under the rule and
/// leaves the title to the panel, as the draft panel does (board 01 ⑧).
struct ScheduleCreateCardView: View {
    let card: ScheduleCard
    var panel = false
    /// What a press came to.
    let decide: (_ allow: Bool) async -> ScheduledModel.PressResult
    @State private var busy = false
    @State private var said: String?
    @State private var pressed = false

    var body: some View {
        let when = card.when.map { ScheduleDisplay.createWhen($0, now: Date(), viewerTimezone: TimeZone.current.identifier) }
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                Label { Text(SC.CreateCard.title).font(.orbitControl.weight(.semibold)) } icon: {
                    // A WHEN rule's card carries the gauge (condition-triggers board ③).
                    Image(systemName: conditionLines == nil ? "calendar" : "gauge.with.dots.needle.33percent")
                        .foregroundStyle(Color.scheduleAccent)
                }
                if !panel, let title = card.title {
                    Text(title).font(.orbitControl.weight(.semibold))
                }
                if let readBack = card.readBack, !readBack.isEmpty {
                    Text(readBack).font(.orbitSubtext).fixedSize(horizontal: false, vertical: true)
                }
                VStack(alignment: .leading, spacing: 8) {
                    if let lines = conditionLines {
                        // When, for a WHEN rule (board ③): the condition in bold with its hold, the re-arm and how it
                        // is checked, the repeat, and the command verbatim — what Create approves.
                        let parts = ConditionDisplay.whenTextParts(lines, condition: card.when?.rule.condition)
                        ScheduleFactRow(label: SC.CreateCard.when) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(parts.bold).fontWeight(.semibold) + Text(parts.rest)
                                if let again = lines.repeat { Text(again).foregroundStyle(.secondary) }
                                Text(lines.detail).foregroundStyle(.secondary)
                                if let awake = lines.awake { Text(awake).foregroundStyle(.secondary) }
                                ConditionCommandBox(command: lines.command)
                            }
                        }
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("schedule-create-when-condition")
                    } else if let when {
                        ScheduleFactRow(label: SC.CreateCard.when) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text([when.rule, when.zone].joined(separator: SC.separator))
                                if let first = when.firstRun {
                                    Text(first).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    if let runsIn = card.runsIn {
                        ScheduleFactRow(label: SC.CreateCard.runsIn) {
                            Text(ScheduleDisplay.runsInText(workspaceName: runsIn.workspaceName ?? runsIn.workspaceId,
                                                            engine: runsIn.engine))
                        }
                    }
                    if let may = card.may {
                        ScheduleFactRow(label: SC.CreateCard.may) { scheduleMayText(may.accessLevel) }
                    }
                    if let costs = card.costs {
                        ScheduleFactRow(label: SC.CreateCard.costs) {
                            scheduleCostsText(runsPerWeek: costs.runsPerWeek, runLimitMinutes: costs.runLimitMinutes)
                        }
                    }
                    if let today = card.today {
                        ScheduleFactRow(label: SC.CreateCard.today) { Text(today.summary ?? today.key) }
                    }
                }
                .padding(.top, 2)
                // The server words it from what the task finds (S5 `scheduleCreateNotice`); else the plain notice.
                Text(card.notice ?? ScheduleDisplay.createNotice(findings: nil))
                    .font(.orbitLabel).foregroundStyle(.secondary)
                if let said {
                    Text(said).font(.orbitLabel).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(14)
            if card.isPending && !pressed {
                ScheduleCardFoot(decline: SC.Actions.notNow, allow: SC.Actions.create, busy: busy,
                                 onDecline: { press(false) }, onAllow: { press(true) },
                                 idPrefix: "schedule-create-\(card.id)")
            }
        }
        .modifier(ScheduleCardBox())
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("schedule-create-card")
    }

    /// A WHEN rule's When lines: the server's, else worked out from the rule.
    private var conditionLines: ScheduleWhenLines? {
        guard let when = card.when, let condition = when.rule.condition else { return nil }
        return when.condition ?? ConditionDisplay.whenLines(condition, runner: nil)
    }

    private func press(_ allow: Bool) {
        busy = true
        Task { @MainActor in
            let result = await decide(allow)
            // A refusal leaves the card to press again; a withdrawn card or a decision leaves it without buttons.
            said = result.said
            pressed = result.settled
            busy = false
        }
    }
}

/// The envelope card (board 02 ②, 01 ⑤): a change that grows what the schedule may do waits on the owner. Allow
/// applies it; Keep … declines.
struct ScheduleEnvelopeCardView: View {
    let card: ScheduleCard
    let scheduleTitle: String?
    let ruleNow: ScheduleRule?
    let decide: (_ allow: Bool) async -> ScheduledModel.PressResult
    @State private var busy = false
    @State private var said: String?
    @State private var pressed = false

    var body: some View {
        if let text = ScheduleDisplay.envelopeCard(card, scheduleTitle: scheduleTitle, ruleNow: ruleNow) {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 10) {
                    Label {
                        Text(text.title).font(.orbitControl.weight(.semibold)).foregroundStyle(Color.scheduleWarn)
                    } icon: {
                        Image(systemName: "exclamationmark.triangle").foregroundStyle(Color.scheduleWarn)
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        if card.envelope?.widens.contains("PROBE_COMMAND") == true {
                            // A new probe command (condition-triggers board ⑥ ③): both commands verbatim, since
                            // changing the command is changing what was approved.
                            if let now = text.now {
                                ScheduleFactRow(label: SC.EnvelopeCard.now) { ConditionCommandBox(command: now.text) }
                            }
                            ScheduleFactRow(label: SC.EnvelopeCard.asked) { ConditionCommandBox(command: text.asked.text) }
                        } else {
                            if let now = text.now {
                                ScheduleFactRow(label: SC.EnvelopeCard.now) { Text(now.text) }
                            }
                            ScheduleFactRow(label: SC.EnvelopeCard.asked) { askedText(text.asked) }
                        }
                    }
                    Text(text.note).font(.orbitLabel).foregroundStyle(.secondary)
                    if let said {
                        Text(said).font(.orbitLabel).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(14)
                if card.isPending && !pressed {
                    ScheduleCardFoot(decline: text.keep, allow: SC.Actions.allow, busy: busy,
                                     onDecline: { press(false) }, onAllow: { press(true) },
                                     idPrefix: "schedule-envelope-\(card.id)")
                }
            }
            .modifier(ScheduleCardBox(warn: true))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("schedule-envelope-card")
        }
    }

    /// Asked, its lead in bold: "**Daily 10:00** · up to 7 runs a week, 30 min each".
    private func askedText(_ side: ScheduleDisplay.EnvelopeSide) -> Text {
        guard !side.lead.isEmpty, side.text.hasPrefix(side.lead) else { return Text(side.text) }
        return Text(side.lead).bold() + Text(String(side.text.dropFirst(side.lead.count)))
    }

    private func press(_ allow: Bool) {
        busy = true
        Task { @MainActor in
            let result = await decide(allow)
            said = result.said
            pressed = result.settled
            busy = false
        }
    }
}

/// "📅 Changed **Codex stable check**: time 10:00 → 09:00 · Undo" (board 01 ⑤ ①, 02 ② ①): the line a change leaves
/// where it was made. Undo goes through the door the record names; one already undone keeps its line.
struct ScheduleRecordLineView: View {
    let record: ScheduleChangeRecord
    let undo: (() async -> String?)?
    let open: (() -> Void)?
    @State private var busy = false
    @State private var undone = false
    @State private var said: String?

    var body: some View {
        let parts = ScheduleDisplay.changeLineParts(record)
        let undoable = ScheduleDisplay.recordUndoable(record) && !undone
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "calendar").foregroundStyle(Color.scheduleAccent)
                (Text(parts.lead) + Text(parts.title).bold() + Text(parts.rest))
                    .foregroundStyle(undoable || record.undo == nil ? .primary : .secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                if record.undo != nil, let undo {
                    Button(SC.Actions.undo) {
                        busy = true
                        Task { @MainActor in
                            said = await undo()
                            undone = said == nil
                            busy = false
                        }
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.scheduleAccent)
                    .disabled(!undoable || busy)
                    .accessibilityIdentifier("schedule-record-undo-\(record.revision)")
                }
                if let open {
                    Button(SC.Actions.open, action: open)
                        .buttonStyle(.plain)
                        .foregroundStyle(Color.scheduleAccent)
                }
            }
            if let said {
                Text(said).font(.orbitLabel).foregroundStyle(.red)
            }
        }
        .font(.orbitSubtext)
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("schedule-record-line")
    }
}

/// The run's timing and access, shown in the conversation.
struct ScheduleRunStripView: View {
    @Environment(AppModel.self) private var appModel
    let schedule: ScheduleView
    let run: ScheduleRunView
    /// The run did not get under way in this session: its strip names no start time (the status card follows).
    var notStarted = false

    var body: some View {
        let zone = TimeZone.current.identifier
        VStack(alignment: .leading, spacing: 6) {
            if fired && !notStarted {
                // A run its condition started names the firing, not a planned time (condition-triggers board ⑤ ②).
                Label {
                    Text(ConditionDisplay.runFiredText(run: run, condition: appModel.scheduled?.condition(conditionID),
                                                       accessLevel: schedule.accessLevel, timezone: zone))
                        .fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: "gauge.with.dots.needle.33percent").foregroundStyle(Color.scheduleAccent)
                }
                .font(.orbitSubtext)
                .foregroundStyle(.primary)
                .accessibilityIdentifier("schedule-run-fired")
            } else {
                Label {
                    Text(notStarted
                         ? ScheduleRunStatus.stripText(plannedAt: run.plannedAt, accessLevel: schedule.accessLevel, timezone: zone)
                         : ScheduleDisplay.runStripText(plannedAt: run.plannedAt, startedAt: run.startedAt,
                                                        accessLevel: schedule.accessLevel, timezone: zone))
                        .fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: "calendar").foregroundStyle(Color.scheduleAccent)
                }
                .font(.orbitSubtext)
                .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 6)
        .task(id: conditionID) {
            if fired, let conditionID { await appModel.scheduled?.loadCondition(conditionID) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("schedule-run-strip")
    }

    private var fired: Bool { run.trigger == "CONDITION" }
    private var conditionID: String? { schedule.rule.conditionId ?? schedule.condition?.id }
}

/// A run's session where the run did not get under way (board docs/mocks/scheduled-run-not-started ②③④), in place of
/// the run's report and the composer: what happened to the run and the doors that act on it.
///   * ② Didn't run: why, each try's time, when it gave up and the next run; Run now and Open schedule.
///   * ③ Queued · runner full: the queue's sentence, the wait and when it gives up; Cancel run and Open schedule.
///   * ④ Started on try N: why this try stopped; Open the run, to the session the run went on in.
struct ScheduleRunStatusCardView: View {
    /// The four doors the card offers; the owner of the card says what each does (and answers a refusal's sentence).
    enum Door { case runNow, openSchedule, cancelRun, openRun }

    let run: ScheduleRunView
    let status: ScheduleRunSessionStatus
    let kind: ScheduleRunStatus.Kind
    /// The machine and the engine of this session, named in the card's sentences.
    let runner: String?
    let engine: String
    let perform: (Door) async -> String?
    @State private var busy = false
    @State private var said: String?

    private typealias A = ScheduleRunStatusCopy.Actions

    var body: some View {
        let zone = TimeZone.current.identifier
        VStack(alignment: .leading, spacing: 10) {
            switch kind {
            case .didntRun:
                let text = ScheduleRunStatus.didntRunText(run: run, status: status, runner: runner ?? "", now: Date(), timezone: zone)
                title(text.title, tone: .secondary)
                body(text.reason)
                HStack(spacing: 6) {
                    ForEach(Array(text.tries.enumerated()), id: \.offset) { _, time in
                        Text(time).font(.orbitLabel).padding(.horizontal, 8).padding(.vertical, 3)
                            .background(Color.secondary.opacity(0.12), in: Capsule())
                    }
                }
                .accessibilityIdentifier("schedule-run-tries")
                if let gaveUp = text.gaveUp { meta(gaveUp) }
                if let next = text.next { meta(next) }
                doors {
                    door(A.runNow, primary: true) { await perform(.runNow) }
                    door(A.openSchedule) { await perform(.openSchedule) }
                }
            case .queuedFull:
                if let gate = status.queue {
                    let text = ScheduleRunStatus.queuedText(gate: gate, machine: runner, now: Date(), timezone: zone)
                    title(text.title, tone: .scheduleWarn)
                    body(text.body)
                    meta(text.waited)
                    doors {
                        door(A.cancelRun) { await perform(.cancelRun) }
                        door(A.openSchedule) { await perform(.openSchedule) }
                    }
                }
            case .startedOn:
                if let text = ScheduleRunStatus.startedOnText(run: run, status: status, engine: engine, runner: runner ?? "",
                                                               timezone: zone), run.sessionId != nil {
                    title(text.title, tone: .green)
                    body(text.body)
                    doors {
                        door(A.openRun, primary: true) { await perform(.openRun) }
                    }
                }
            }
            if let said {
                Text(said).font(.orbitLabel).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.secondary.opacity(0.3)))
        .disabled(busy)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("schedule-run-card-\(kind.rawValue)")
    }

    private func title(_ text: String, tone: Color) -> some View {
        HStack(spacing: 8) {
            Circle().fill(tone).frame(width: 9, height: 9)
            Text(text).font(.orbitControl.weight(.semibold))
        }
    }

    private func body(_ text: String) -> some View {
        Text(text).font(.orbitSubtext).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }

    private func meta(_ text: String) -> some View {
        Text(text).font(.orbitLabel).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }

    private func doors<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        HStack(spacing: 10) { content() }
    }

    @ViewBuilder
    private func door(_ title: String, primary: Bool = false, _ action: @escaping () async -> String?) -> some View {
        let label = Text(title).lineLimit(1).minimumScaleFactor(0.7).frame(maxWidth: .infinity)
        if primary {
            Button { press(action) } label: { label }
                .buttonStyle(.borderedProminent).accessibilityIdentifier("schedule-run-\(title)")
        } else {
            Button { press(action) } label: { label }
                .buttonStyle(.bordered).accessibilityIdentifier("schedule-run-\(title)")
        }
    }

    private func press(_ action: @escaping () async -> String?) {
        busy = true
        Task { @MainActor in
            said = await action()
            busy = false
        }
    }
}

/// What the run reported (board 02 ④, 01 ⑦ ②): "Reported: Changed · codex@0.49.0", its summary and its links; a run
/// that failed says why instead.
struct ScheduleRunReportView: View {
    let run: ScheduleRunView
    let findings: [ScheduleFindingView]

    var body: some View {
        let failed = ScheduleDisplay.runReportFailed(run.state)
        let facts = ScheduleDisplay.runFindingFacts(run, findings: findings)
        let head = failed
            ? ScheduleDisplay.runLine(state: run.state, summary: run.summary, failureReason: run.failureReason,
                                      reasonText: run.reasonText)
            : ScheduleDisplay.reportedText(state: run.state, key: run.key, notified: facts.notified)
        let tint: Color = failed ? .red : .green
        VStack(alignment: .leading, spacing: 4) {
            Label { Text(head).font(.orbitSubtext.weight(.semibold)) } icon: {
                Image(systemName: failed ? "exclamationmark.triangle" : "checkmark.circle").foregroundStyle(tint)
            }
            if !failed, let summary = run.summary, !summary.isEmpty {
                Text(summary).font(.orbitSubtext).fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .overlay(alignment: .leading) {
            Rectangle().fill(tint).frame(width: 3)
        }
        .background(tint.opacity(0.06), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("schedule-run-report")
    }
}

/// A scheduled task's row in a conversation (`DeliveredDecisionCard`): drawn from the console's read on every
/// render; every press goes through `ScheduledModel` and reads the conversation's cards back.
struct ScheduleConsoleCard: View {
    @Environment(AppModel.self) private var appModel
    let console: ConsoleModel
    let kind: DeliveredDecisionCard.Kind

    var body: some View {
        switch kind {
        case .scheduleCard(let requestID):
            if let card = console.scheduleCard(requestID) {
                if card.isCreate {
                    ScheduleCreateCardView(card: card, decide: { await decide(card, $0) })
                } else {
                    let schedule = card.scheduleId.flatMap { appModel.scheduled?.schedule($0) }
                    ScheduleEnvelopeCardView(card: card, scheduleTitle: schedule?.title, ruleNow: schedule?.rule,
                                             decide: { await decide(card, $0) })
                        .task { if let id = card.scheduleId, schedule == nil { await appModel.scheduled?.loadDetail(id) } }
                }
            }
        case .scheduleRecord(let scheduleID, let revision):
            if let record = console.scheduleRecord(scheduleID: scheduleID, revision: revision) {
                ScheduleRecordLineView(
                    record: record,
                    undo: {
                        guard let scheduled = appModel.scheduled else { return nil }
                        let said = await scheduled.undo(record.scheduleId, revision: record.revision)
                        await console.refreshScheduleCards(force: true)
                        return said
                    },
                    open: { appModel.openSchedule(record.scheduleId) })
            }
        case .scheduleChangeOpening:
            // A change conversation opens with Orbit's message, before the person's first words (§8.2).
            if let opening = console.scheduleChangeOpening {
                ScheduleChangeOpeningView(opening: opening)
            }
        case .scheduleRunStrip:
            if let found = console.scheduleRun {
                let card = console.scheduleRunCard
                ScheduleRunStripView(schedule: found.schedule, run: found.run, notStarted: card != nil)
                if let card, let status = console.scheduleCards?.runStatus {
                    ScheduleRunStatusCardView(
                        run: found.run, status: status, kind: card, runner: console.runnerName,
                        engine: ProviderEngines.names.first { $0.engine == console.engine }?.name ?? console.engine,
                        perform: { door in
                            let said: String?
                            switch door {
                            case .runNow:
                                let started = await appModel.scheduled?.runNowSession(found.run.scheduleId)
                                said = started?.said
                                if let session = started?.sessionID { appModel.openScheduleRun(sessionID: session) }
                            case .cancelRun: said = await appModel.scheduled?.stop(runID: found.run.id, scheduleID: found.run.scheduleId)
                            case .openSchedule: appModel.openSchedule(found.run.scheduleId); said = nil
                            case .openRun:
                                if let session = found.run.sessionId { appModel.openScheduleRun(sessionID: session) }
                                said = nil
                            }
                            await console.refreshScheduleCards(force: true)
                            return said
                        })
                }
            }
        case .scheduleRunReport:
            // A run that did not get under way here has no report of its own: its card says what happened.
            if let found = console.scheduleRun, console.scheduleRunCard == nil {
                ScheduleRunReportView(run: found.run, findings: console.scheduleRunDetail?.findings ?? [])
            }
        default:
            EmptyView()
        }
    }

    private func decide(_ card: ScheduleCard, _ allow: Bool) async -> ScheduledModel.PressResult {
        guard let scheduled = appModel.scheduled else { return .refused(ScheduledModel.unreachable) }
        let said = allow ? await scheduled.allow(card) : await scheduled.decline(card)
        await console.refreshScheduleCards(force: true)
        return said
    }
}

// MARK: - Waiting on you (board 01 ⑥, 02 ⑤)

/// One of the four kinds no session can file: a failed schedule, a held one, a run waiting on an approval, a run
/// asking for a wider envelope. The amber head names the kind and when; each answers at its own door.
struct ScheduleWaitingCardView: View {
    @Environment(AppModel.self) private var appModel
    let item: ScheduleWaitingItem
    @State private var busy = false
    @State private var said: String?

    var body: some View {
        let scheduled = appModel.scheduled
        let schedule = scheduled?.schedule(item.scheduleId)
        let zone = TimeZone.current.identifier
        let content = text(schedule: schedule, scheduled: scheduled, zone: zone)
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(content.kind).font(.orbitLabel.weight(.semibold)).foregroundStyle(Color.scheduleWarn)
                Spacer(minLength: 8)
                Text(ScheduleDisplay.parse(item.createdAt).map {
                    ScheduleDisplay.whenText($0, now: Date(), timezone: zone)
                } ?? "")
                .font(.orbitLabel).foregroundStyle(Color.scheduleWarn.opacity(0.8))
            }
            .padding(.horizontal, 14).padding(.vertical, 8)
            .background(Color.scheduleWarn.opacity(0.10))
            VStack(alignment: .leading, spacing: 8) {
                Text(content.title).font(.orbitControl.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                if let command = content.command {
                    Text(command).font(.orbitMono).foregroundStyle(.secondary).lineLimit(3)
                }
                Text(content.body).font(.orbitSubtext).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let said {
                    Text(said).font(.orbitLabel).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
                }
                buttons(schedule: schedule)
                if let note = content.note {
                    Text(note).font(.orbitLabel).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(14)
        }
        .background(Color.scheduleWarn.opacity(0.03), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.scheduleWarn.opacity(0.45)))
        .disabled(busy)
        .task(id: item.id) { await load(schedule: schedule) }
        // A container, so its own identifier does not overwrite its buttons'.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("schedule-waiting-\(item.kind)")
    }

    private struct WaitingContent {
        var kind: String
        var title: String
        var body: String
        var command: String? = nil
        var note: String? = nil
    }

    private func text(schedule: ScheduleView?, scheduled: ScheduledModel?, zone: String) -> WaitingContent {
        let title = schedule?.title ?? item.title
        switch item.kind {
        case "SCHEDULE_FAILED":
            let run = schedule?.lastRun
            let t = ScheduleDisplay.failedWaiting(title: title, consecutiveFailures: max(schedule?.consecutiveFailures ?? 1, 1),
                                                  failureReason: run?.failureReason, reasonText: run?.reasonText,
                                                  summary: run?.summary,
                                                  plannedAt: run?.plannedAt ?? item.createdAt, timezone: zone)
            return WaitingContent(kind: t.kind, title: t.title, body: t.body)
        case "SCHEDULE_HELD":
            let t = ScheduleDisplay.heldWaiting(title: title, heldReason: schedule?.heldReason,
                                                plannedAt: schedule?.nextDueAt ?? schedule?.lastRun?.plannedAt ?? item.createdAt,
                                                agentName: schedule?.agentName,
                                                workspaceName: schedule?.workspaceName, now: Date(), timezone: zone)
            return WaitingContent(kind: t.kind, title: t.title, body: t.body)
        case "SCHEDULE_APPROVAL":
            let approval = item.approvalId.flatMap { scheduled?.approvals[$0] }
            let rules = approval.flatMap { a in a.toolName.flatMap { tool in a.input.map { Approvals.rememberRules(toolName: tool, input: $0) } } } ?? []
            let deadline = ScheduleDisplay.parse(item.createdAt).map {
                ISO8601DateFormatter().string(from: $0.addingTimeInterval(ScheduleDisplay.approvalTimeout))
            } ?? item.createdAt
            let t = ScheduleDisplay.approvalWaiting(title: title, deadline: deadline, nextAt: schedule?.nextDueAt,
                                                    pattern: Approvals.ruleNames(rules).joined(separator: ", "),
                                                    workspaceName: schedule?.workspaceName ?? "", now: Date(),
                                                    timezone: zone)
            return WaitingContent(kind: t.kind, title: t.title, body: t.body,
                           command: approval?.input?["command"]?.stringValue,
                           note: rules.isEmpty ? nil : t.alwaysAllow)
        default:
            let card = item.scheduleChangeRequestId.flatMap { scheduled?.cards[$0] }
            var body = item.why
            var heading = item.title
            if let card, let envelope = card.envelope,
               let text = ScheduleDisplay.envelopeCard(card, scheduleTitle: schedule?.title, ruleNow: schedule?.rule) {
                heading = text.title
                var names: [String: String] = [:]
                for lines in [envelope.now, envelope.asked].compactMap({ $0 }) {
                    if let name = lines.runsIn.workspaceName { names[lines.runsIn.workspaceId] = name }
                }
                body = ScheduleDisplay.widenWaitingText(reason: item.why, widens: envelope.widens,
                                                        now: envelope.now?.envelope, asked: envelope.asked.envelope,
                                                        ruleNow: schedule?.rule,
                                                        ruleAsked: ScheduleRule(json: card.proposed?["rule"]),
                                                        workspaceNames: names)
            }
            return WaitingContent(kind: SC.Waiting.kindsSchedule, title: heading, body: body)
        }
    }

    @ViewBuilder
    private func buttons(schedule: ScheduleView?) -> some View {
        HStack(spacing: 10) {
            switch item.kind {
            case "SCHEDULE_FAILED":
                primary(SC.Actions.openRun) {
                    if let session = schedule?.lastRun?.sessionId {
                        appModel.openScheduleRun(sessionID: session)
                    } else {
                        appModel.openSchedule(item.scheduleId)
                    }
                    return nil
                }
                secondary(SC.Actions.pauseSchedule) { await appModel.scheduled?.pause(item.scheduleId) }
            case "SCHEDULE_HELD":
                let agent = schedule?.heldReason == "AGENT_DISABLED" || schedule?.heldReason == "AGENT_MISSING"
                primary(agent ? SC.Actions.openAgentSettings : SC.Actions.openSchedule) {
                    appModel.openSchedule(item.scheduleId)
                    return nil
                }
                secondary(SC.Actions.resume) { await appModel.scheduled?.resume(item.scheduleId) }
            case "SCHEDULE_APPROVAL":
                secondary(SC.Actions.deny) { await approval(allow: false, always: false) }
                secondary(SC.Actions.allowOnce) { await approval(allow: true, always: false) }
                primary(SC.Actions.alwaysAllow) { await approval(allow: true, always: true) }
            default:
                let card = item.scheduleChangeRequestId.flatMap { appModel.scheduled?.cards[$0] }
                let keep = card.flatMap {
                    ScheduleDisplay.envelopeCard($0, scheduleTitle: schedule?.title, ruleNow: schedule?.rule)?.keep
                } ?? SC.keep["other"]!
                secondary(keep) { await widen(card, allow: false) }
                primary(SC.Actions.allow) { await widen(card, allow: true) }
            }
        }
    }

    private func primary(_ title: String, _ action: @escaping () async -> String?) -> some View {
        Button { run(action) } label: {
            Text(title).lineLimit(1).minimumScaleFactor(0.7).frame(maxWidth: .infinity)
        }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("schedule-waiting-\(title)")
    }

    private func secondary(_ title: String, _ action: @escaping () async -> String?) -> some View {
        Button { run(action) } label: {
            Text(title).lineLimit(1).minimumScaleFactor(0.7).frame(maxWidth: .infinity)
        }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("schedule-waiting-\(title)")
    }

    private func run(_ action: @escaping () async -> String?) {
        busy = true
        Task { @MainActor in
            said = await action()
            busy = false
            await appModel.ownerRequests?.load()
        }
    }

    private func approval(allow: Bool, always: Bool) async -> String? {
        guard let session = item.askedBySessionId, let approval = item.approvalId else { return nil }
        return await appModel.scheduled?.decideApproval(sessionID: session, approvalID: approval, allow: allow,
                                                        always: always)
    }

    private func widen(_ card: ScheduleCard?, allow: Bool) async -> String? {
        guard let card, let scheduled = appModel.scheduled else { return nil }
        return (allow ? await scheduled.allow(card) : await scheduled.decline(card)).said
    }

    private func load(schedule: ScheduleView?) async {
        guard let scheduled = appModel.scheduled else { return }
        if schedule == nil { await scheduled.load() }
        if let id = item.scheduleChangeRequestId { await scheduled.loadCard(id) }
        if let approval = item.approvalId, let session = item.askedBySessionId {
            await scheduled.loadApproval(sessionID: session, approvalID: approval)
        }
    }
}
