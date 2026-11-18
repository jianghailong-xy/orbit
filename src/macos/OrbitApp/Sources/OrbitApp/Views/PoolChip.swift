import SwiftUI

/// A small tag: NEXT, ADMIN — and Shared, in the brand colour. The account pools' rows wear it
/// (MachinesAndModelsSections, and the pool pages in ProviderPoolViews, iOS), and so do an engine page's
/// account rows, on the Mac as well (RunnerEnginePage).
struct PoolChip: View {
    let text: String
    var brand = false

    var body: some View {
        Text(text)
            .font(.orbitMeta.weight(.bold))
            .foregroundStyle(brand ? Color.accentColor : Color.secondary)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(brand ? Color.accentColor.opacity(0.12) : Color.primary.opacity(0.065),
                        in: RoundedRectangle(cornerRadius: 5, style: .continuous))
    }
}
