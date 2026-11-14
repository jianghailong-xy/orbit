import Observation

/// Writes that leave an observed value alone when it has not moved.
///
/// `@Observable` invalidates its observers on every assignment, equal value or not: the generated
/// setter announces the write whatever the value is. The section stores behind the sidebar and the
/// Lists are read whole by bodies that re-read them on every pass, so a poll whose answer is what is
/// already in hand must not touch them at all. `assignIfChanged` is that write — the compare costs
/// far less than the re-render it avoids, and an unchanged reload writes nothing observable.
@available(macOS 14.0, *)
public extension Observable where Self: AnyObject {
    /// Assigns `value` to `keyPath` only when it differs from the value in hand.
    func assignIfChanged<Value: Equatable>(_ keyPath: ReferenceWritableKeyPath<Self, Value>, _ value: Value) {
        guard self[keyPath: keyPath] != value else { return }
        self[keyPath: keyPath] = value
    }
}
