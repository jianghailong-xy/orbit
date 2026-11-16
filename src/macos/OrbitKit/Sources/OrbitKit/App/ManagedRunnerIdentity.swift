import Foundation

/// The account's managed runner's id, as `ManagedRunnerModel` last read it from GET /managed-runner
/// (nil with the feature off, signed out, or before the first answer). `RunnerPageFormat.displayName`
/// reads it so every screen that names a machine says Orbit Cloud for that one — decided by id, never
/// by the stored name `orbit-managed` — without each view threading the status through.
public enum ManagedRunnerIdentity {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var stored: String?

    public static var runnerID: String? {
        get {
            lock.lock()
            defer { lock.unlock() }
            return stored
        }
        set {
            lock.lock()
            defer { lock.unlock() }
            stored = newValue
        }
    }
}
