import OrbitKit
import SwiftUI

/// The managed runner's state (docs/managed-runner-design.md, "Server and three client interfaces"):
/// above the composer of a workspace on the managed runner, and on Infrastructure for an account
/// with no runner yet. The words are the shared display's (`ManagedRunnerLogic.display`, the same as
/// the web's), and the actions only those the server allows: Retry, Set up, and the way to the
/// runner's runtimes when what it lacks is one signed in.
struct ManagedRunnerBanner: View {
    let display: ManagedRunnerDisplay
    /// The managed runner, for the way to its runtimes; nil before a mapping exists.
    var runnerID: String? = nil
    @Environment(AppModel.self) private var model

    /// The kinds that ask for somebody's attention rather than time.
    private var attention: Bool {
        switch display.kind {
        case .failed, .waitingOperator, .removed, .removing, .notOffered, .modelUnavailable: return true
        default: return false
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 7) {
                if display.moving {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: attention ? "exclamationmark.circle.fill" : "circle.fill")
                        .foregroundStyle(attention ? Color.orange : Color.accentColor)
                        .imageScale(attention ? .medium : .small)
                }
                Text(display.title).font(.orbitProse.bold())
            }
            Text(display.detail).font(.orbitLabel).foregroundStyle(.secondary)
            if let error = model.managedRunner?.errorText {
                Text(error).font(.orbitLabel).foregroundStyle(.red)
            }
            if display.retry || display.ensure || display.signIn {
                HStack(spacing: 10) {
                    if display.signIn, let runnerID {
                        Button(ManagedRunnerCopy.signIn) { model.route(to: .runner(runnerID)) }
                            .buttonStyle(.bordered)
                    }
                    if display.retry {
                        Button(ManagedRunnerCopy.retry) { Task { await model.managedRunner?.retry() } }
                            .buttonStyle(.borderedProminent)
                            .disabled(model.managedRunner?.acting == true)
                    }
                    if display.ensure {
                        Button(ManagedRunnerCopy.ensure) { Task { await model.managedRunner?.ensure() } }
                            .buttonStyle(.borderedProminent)
                            .disabled(model.managedRunner?.acting == true)
                    }
                }
                .padding(.top, 2)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background((attention ? Color.orange : Color.accentColor).opacity(0.09),
                    in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .contain)
    }
}
