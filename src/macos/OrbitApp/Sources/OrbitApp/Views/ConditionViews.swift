import SwiftUI
import OrbitKit

// Conditions on the Apple clients (docs/condition-triggers-design.md §9, board docs/mocks/condition-triggers/, iOS the
// reference): the inspector's Condition and How it checks blocks, the command as a card shows it, the task create
// card's Starts when / Today / If never, and the two Waiting on you cards a condition files. The words and rules are
// OrbitKit's (`ConditionCopy`, `ConditionDisplay`).

private typealias CC = ConditionCopy

/// A probe command as a card shows it, verbatim, in a grey box (board ② ③ ⑥): what Create approved, and what runs.
struct ConditionCommandBox: View {
    let command: String

    var body: some View {
        Text(command)
            .font(.orbitMono)
            .foregroundStyle(.primary)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10).padding(.vertical, 7)
            .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .accessibilityIdentifier("condition-command")
    }
}

/// The inspector's two blocks for a WHEN rule (board ⑥ ② ③): Condition — the reading, its age, a bar with the firing
/// and re-arm lines, the rule in words — and How it checks — interval and runner, the command, when it was approved.
struct ConditionBlocksView: View {
    let condition: ConditionView
    let timezone: String
    let now: Date

    var body: some View {
        let block = ConditionDisplay.conditionBlock(condition, now: now)
        let checks = ConditionDisplay.checksBlock(condition, timezone: timezone)
        VStack(alignment: .leading, spacing: 14) {
            section(CC.conditionSection) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        if let reading = block.reading {
                            Text(reading).font(.title.weight(.bold)).monospacedDigit()
                        }
                        Text(block.checked).font(.orbitSubtext).foregroundStyle(.secondary)
                    }
                    if let cantRead = block.cantRead {
                        Label(cantRead, systemImage: "exclamationmark.triangle")
                            .font(.orbitLabel.weight(.semibold)).foregroundStyle(Color.orange)
                    }
                    if let bar = block.bar { ConditionBar(bar: bar) }
                    Text(block.rule).font(.orbitLabel).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let again = block.repeat {
                        Text(again).font(.orbitLabel).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("condition-block")
            section(CC.howItChecks) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(checks.every).font(.orbitSubtext).fixedSize(horizontal: false, vertical: true)
                    ConditionCommandBox(command: checks.command)
                    Text(checks.approved).font(.orbitLabel).foregroundStyle(.secondary)
                    if let awake = checks.awake {
                        Text(awake).font(.orbitLabel).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("condition-how-it-checks")
        }
    }

    private func section<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased()).font(.orbitLabel).foregroundStyle(.secondary).padding(.leading, 4)
            content()
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .background(Color.scheduleCardFill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.scheduleCardEdge))
        }
    }
}

/// The reading on one scale with the re-arm (grey) and firing (red) lines and their values under them (board ⑥ ②).
struct ConditionBar: View {
    let bar: ConditionDisplay.Bar

    var body: some View {
        VStack(spacing: 4) {
            GeometryReader { geo in
                let w = geo.size.width
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.secondary.opacity(0.15)).frame(height: 8)
                    Capsule().fill(Color.accentColor).frame(width: max(8, w * bar.value), height: 8)
                    if let rearm = bar.rearm {
                        Rectangle().fill(Color.secondary.opacity(0.6)).frame(width: 2, height: 18)
                            .offset(x: w * rearm - 1)
                    }
                    Rectangle().fill(Color.red).frame(width: 2, height: 18).offset(x: w * bar.fire - 1)
                }
                .frame(height: 18)
            }
            .frame(height: 18)
            GeometryReader { geo in
                let w = geo.size.width
                // Two labels close together move apart: the re-arm one to the left of its line.
                let close = bar.rearm.map { bar.fire - $0 < 0.08 } ?? false
                ZStack {
                    if let rearm = bar.rearm, let label = bar.rearmLabel {
                        Text(label).font(.orbitMeta).foregroundStyle(.secondary).fixedSize()
                            .position(x: w * rearm - (close ? 18 : 0), y: 7)
                    }
                    Text(bar.fireLabel).font(.orbitMeta).foregroundStyle(Color.red).fixedSize()
                        .position(x: min(w - 14, w * bar.fire + (close ? 14 : 0)), y: 7)
                }
            }
            .frame(height: 14)
        }
        .accessibilityHidden(true)
    }
}

/// The task create card's condition lines (board frame 2): Starts when — the condition, how it is checked, the
/// command — Today, and If never.
struct StartWhenLinesView: View {
    let lines: StartWhenCardLines

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ScheduleFactRow(label: CC.startsWhen, labelWidth: 92) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(lines.startsWhen).fontWeight(.semibold)
                    Text(lines.checked).foregroundStyle(.secondary)
                    if let awake = lines.awake { Text(awake).foregroundStyle(.secondary) }
                    ConditionCommandBox(command: lines.command)
                }
            }
            ScheduleFactRow(label: CC.today, labelWidth: 92) { Text(lines.today) }
            ScheduleFactRow(label: CC.ifNever, labelWidth: 92) { Text(lines.ifNever) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("start-when-lines")
    }
}

/// A condition's Waiting on you card (board ⑥ ①): the amber "Condition" head with when, the server's title and why,
/// then Pause and Look into it on a can't-read card, or Keep waiting and Stop on the 30-day question.
struct ConditionWaitingCardView: View {
    @Environment(AppModel.self) private var appModel
    let item: ConditionWaitingItem
    @State private var busy = false
    @State private var said: String?

    var body: some View {
        let condition = appModel.scheduled?.condition(item.conditionId)
        let zone = TimeZone.current.identifier
        let actions = ConditionDisplay.waitingActions(item, scheduleId: condition?.scheduleId)
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(CC.waitingKind).font(.orbitLabel.weight(.semibold)).foregroundStyle(Color.scheduleWarn)
                Spacer(minLength: 8)
                Text(ScheduleDisplay.parse(item.createdAt).map {
                    ScheduleDisplay.whenText($0, now: Date(), timezone: zone)
                } ?? "")
                .font(.orbitLabel).foregroundStyle(Color.scheduleWarn.opacity(0.8))
            }
            .padding(.horizontal, 14).padding(.vertical, 8)
            .background(Color.scheduleWarn.opacity(0.10))
            VStack(alignment: .leading, spacing: 8) {
                Text(item.title).font(.orbitControl.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                Text(item.why).font(.orbitSubtext).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let said {
                    Text(said).font(.orbitLabel).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
                }
                HStack(spacing: 10) {
                    ForEach(Array(actions.enumerated()), id: \.offset) { index, title in
                        let last = index == actions.count - 1
                        Button { press(index: index, title: title, condition: condition) } label: {
                            Text(title).lineLimit(1).minimumScaleFactor(0.7).frame(maxWidth: .infinity)
                        }
                        .modifier(ConditionCardButtonStyle(prominent: last))
                        .accessibilityIdentifier("condition-waiting-\(title)")
                    }
                }
            }
            .padding(14)
        }
        .background(Color.scheduleWarn.opacity(0.03), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.scheduleWarn.opacity(0.45)))
        .disabled(busy)
        .task(id: item.id) {
            if let id = item.conditionId { await appModel.scheduled?.loadCondition(id) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("condition-waiting-\(item.kind)")
    }

    private func press(index: Int, title: String, condition: ConditionView?) {
        busy = true
        Task { @MainActor in
            said = await act(index: index, title: title, condition: condition)
            busy = false
            await appModel.ownerRequests?.load()
        }
    }

    private func act(index: Int, title: String, condition: ConditionView?) async -> String? {
        if item.isStillWaiting {
            // The 30-day question's answers are its options, by index: Keep waiting (0), Stop (1).
            return await appModel.ownerRequests?.answerCondition(item, option: index)
        }
        if title == CC.pause, let schedule = condition?.scheduleId {
            return await appModel.scheduled?.pause(schedule)
        }
        if let schedule = condition?.scheduleId {
            appModel.openSchedule(schedule)
        } else if let task = condition?.taskId {
            appModel.route(to: .task(task))
        }
        return nil
    }
}

private struct ConditionCardButtonStyle: ViewModifier {
    let prominent: Bool
    func body(content: Content) -> some View {
        if prominent {
            content.buttonStyle(.borderedProminent)
        } else {
            content.buttonStyle(.bordered)
        }
    }
}
