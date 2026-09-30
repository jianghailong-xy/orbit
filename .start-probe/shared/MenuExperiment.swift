import SwiftUI
import OrbitKit

// TEMPORARY evidence probe: which way of writing and placing the Tasks land on menu draws each
// option's second line on iOS 26. Round 2 (round 1: a fixed-size menu draws a long second line
// empty). Every row is the card's own row — "Tasks land on" · Spacer · Menu — unless it says what it
// changes; the same rows sit near the top of the screen (menus open downward) and near the bottom
// (they open upward). Opened by `-screen menus`; the UI test opens each in turn and photographs it.
struct MenuExperiment: View {
    @State private var line: IntegrationLine = .projectBranch

    private func binding(_ value: IntegrationLine) -> Binding<Bool> {
        Binding(get: { line == value }, set: { if $0 { line = value } })
    }

    @ViewBuilder
    private func toggles(short: Bool = false) -> some View {
        Toggle(isOn: binding(.projectBranch)) {
            Text(RunSettings.lineProjectBranch)
            Text(short ? "checked together" : RunSettings.lineProjectBranchHint)
        }
        Toggle(isOn: binding(.main)) {
            Text(RunSettings.lineMain)
            Text(short ? "every merge asks you" : RunSettings.lineMainHint)
        }
    }

    private func label(_ name: String) -> some View {
        HStack(spacing: 4) {
            Text(name).lineLimit(1)
            Image(systemName: "chevron.up.chevron.down").font(.caption2)
        }
        .font(.body)
        .foregroundStyle(Color.blue)
    }

    /// The card's row, as ApprovalCards.swift writes it.
    private func cardRow(_ name: String, short: Bool = false) -> some View {
        HStack(spacing: 8) {
            Text("Tasks land on")
            Spacer(minLength: 8)
            Menu { toggles(short: short) } label: { label(name) }
                .disabled(false)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 12))
    }

    private var rows: some View {
        VStack(alignment: .leading, spacing: 10) {
            cardRow("R1 card row")
            cardRow("R2 card short", short: true)
            // R3 — label at the leading edge.
            HStack {
                Menu { toggles() } label: { label("R3 leading") }
                Spacer()
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(Color.white, in: RoundedRectangle(cornerRadius: 12))
            // R4 — the platform's labelled row.
            LabeledContent("Tasks land on") {
                Menu { toggles() } label: { label("R4 labeled") }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(Color.white, in: RoundedRectangle(cornerRadius: 12))
            // R5 — Buttons rather than Toggles, in the card's row.
            HStack(spacing: 8) {
                Text("Tasks land on")
                Spacer(minLength: 8)
                Menu {
                    Button { line = .projectBranch } label: {
                        Text(RunSettings.lineProjectBranch)
                        Text(RunSettings.lineProjectBranchHint)
                    }
                    Button { line = .main } label: {
                        Text(RunSettings.lineMain)
                        Text(RunSettings.lineMainHint)
                    }
                } label: { label("R5 buttons") }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(Color.white, in: RoundedRectangle(cornerRadius: 12))
        }
    }

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text("menu experiment 2 — top").font(.headline).padding(.bottom, 10)
                    rows
                    Spacer(minLength: 40)
                    Text("— bottom (menus open upward) —").font(.headline).padding(.bottom, 10)
                    VStack(alignment: .leading, spacing: 10) {
                        cardRow("B1 card row")
                        cardRow("B2 card short", short: true)
                        HStack {
                            Menu { toggles() } label: { label("B3 leading") }
                            Spacer()
                        }
                        .padding(.horizontal, 12).padding(.vertical, 10)
                        .background(Color.white, in: RoundedRectangle(cornerRadius: 12))
                    }
                    Text("chosen: \(line.rawValue)").accessibilityIdentifier("probe-chosen")
                        .padding(.top, 10)
                }
                .padding(20)
                .frame(minHeight: geometry.size.height - 40, alignment: .top)
                .background(Color.blue.opacity(0.07))
            }
        }
    }
}
