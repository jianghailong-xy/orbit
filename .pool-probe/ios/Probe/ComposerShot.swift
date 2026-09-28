// TEMPORARY evidence probe (see ../../README.md): the composer's foot as `ComposerView.toolbar` draws
// it — the pool's key label beside the plan-usage gauge. Appended by gen.py to Generated/ComposerPieces
// (which is where its imports are), so it sits in one file with the pill and the row it draws: both are
// the app's own, cut verbatim out of ComposerView.swift. Only the `HStack` around them — its spacing,
// padding and list-subtitle font, repeated from that same toolbar row — is the probe's, because the
// real toolbar is a private property of a view that needs the whole app.
struct ComposerShot: View {
    private var console: PoolComposerStandIn {
        PoolComposerStandIn(pool: ProbeData.teamPool, memberID: nil)
    }

    var body: some View {
        VStack(spacing: 24) {
            HStack(spacing: 8) {
                Spacer(minLength: 8)
                ComposerPoolRow(console: console)
                if let usage = console.planUsage {
                    PlanUsageIndicator(usage: usage)
                }
            }
            .padding(.horizontal, 8)
            .padding(.top, 6)
            .padding(.bottom, 8)
            .font(.orbitListSubtitle)
            .background(RoundedRectangle(cornerRadius: 24, style: .continuous).fill(.quaternary.opacity(0.5)))
            .padding(.horizontal, 12)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
