import AppKit
import Carbon.HIToolbox

// The deferred Phase-3 feature, finished in F: a true system-wide "summon Orbit" hotkey (⌥Space)
// via Carbon `RegisterEventHotKey`. This is the standard way to get a global hotkey in a
// non-sandboxed Developer-ID app — an `NSEvent` global monitor would need Accessibility
// permission, which `RegisterEventHotKey` does not. Swift 5 language mode (see Package.swift)
// keeps the C-callback ↔ global-state bridge a non-issue. Carbon-only code, so it lives in the
// macOS-only OrbitApp (never built on Linux; verified on the macOS CI toolchain).

// A Carbon event handler is a bare C function pointer and can't capture context, so the action
// lives in a file-global the handler reads. (Single hotkey, set once at launch.)
private var orbitHotKeyAction: (() -> Void)?

private func orbitHotKeyHandler(_ next: EventHandlerCallRef?,
                                _ event: EventRef?,
                                _ userData: UnsafeMutableRawPointer?) -> OSStatus {
    DispatchQueue.main.async { orbitHotKeyAction?() }
    return noErr
}

enum HotKeyManager {
    private static var hotKeyRef: EventHotKeyRef?
    private static var eventHandler: EventHandlerRef?

    /// Register ⌥Space to run `action`. Idempotent; call once at launch. If registration fails
    /// (e.g. the combo is already claimed) it's a silent no-op — the rest of the app is unaffected.
    static func register(_ action: @escaping () -> Void) {
        orbitHotKeyAction = action
        guard eventHandler == nil else { return }

        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                 eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), orbitHotKeyHandler, 1, &spec, nil, &eventHandler)

        let hotKeyID = EventHotKeyID(signature: OSType(0x4F524254) /* 'ORBT' */, id: 1)
        RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey),
                            hotKeyID, GetApplicationEventTarget(), 0, &hotKeyRef)
    }

    /// Bring Orbit to the front and focus its window — the action the hotkey fires.
    static func summonApp() {
        NSApp.activate(ignoringOtherApps: true)
        NSApp.windows.first { $0.canBecomeKey }?.makeKeyAndOrderFront(nil)
    }
}
