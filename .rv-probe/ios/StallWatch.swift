import Darwin
import Foundation
import MachO
import os

// TEMPORARY probe instrument (never merged), task 34tKCNy9aN3Itk5SgIoIl: a watchdog thread inside the probe app, to
// say what the app is doing while it sends nothing after a Keep.
//
// Every 20 ms it asks the main queue for a pong. Once the oldest unanswered ping is more than 250 ms old, the main
// thread is late: every 100 ms the watchdog suspends it for a moment, walks its frame pointers into a buffer it
// allocated up front (nothing that can take a lock while the main thread is held), resumes it, and only then
// symbolizes the stack with dladdr and writes it to STALLWATCH_LOG. A window the UI test asks for
// (STALLWATCH_DIR/stallwatch-window.req, just before a press) writes the main thread's stack every 100 ms whether it is
// late or not, and every thread's stack every 2 s, for WINDOW seconds. A heartbeat line every second, and a HELD
// line when the watchdog itself did not run for a while, tell a blocked main thread from a process that did not run.
// Lines start with the host's wall clock in epoch ms, the clock stub.py stamps requests with.
enum StallWatch {
    private static let window: UInt64 = 22_000  // ms
    private static let maxFrames = 160

    nonisolated(unsafe) private static var mainPort: thread_act_t = 0
    nonisolated(unsafe) private static var selfPort: thread_act_t = 0
    nonisolated(unsafe) private static var fd: Int32 = -1
    nonisolated(unsafe) private static var dir = ""
    nonisolated(unsafe) private static var frames = UnsafeMutablePointer<UInt64>.allocate(capacity: 256)
    nonisolated(unsafe) private static var state: UnsafeMutablePointer<UInt64> = {
        let words = UnsafeMutablePointer<UInt64>.allocate(capacity: 40)
        words.initialize(repeating: 0, count: 40)
        return words
    }()
    nonisolated(unsafe) private static var symbols: [UInt64: String] = [:]
    private static let pong = OSAllocatedUnfairLock(initialState: (seq: UInt64(0), at: UInt64(0)))

    /// Call once, on the main thread, before anything else.
    static func start() {
        let env = ProcessInfo.processInfo.environment
        guard let path = env["STALLWATCH_LOG"], !path.isEmpty else { return }
        dir = env["STALLWATCH_DIR"] ?? (path as NSString).deletingLastPathComponent
        mainPort = pthread_mach_thread_np(pthread_self())
        fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0o644)
        if fd < 0 {
            let fallback = NSTemporaryDirectory() + "stallwatch.log"
            fd = open(fallback, O_WRONLY | O_CREAT | O_APPEND, 0o644)
        }
        line("START pid=\(getpid()) path=\(path) main=\(mainPort)")
        images()
        let thread = Thread { StallWatch.loop() }
        thread.name = "probe.stallwatch"
        thread.qualityOfService = .userInteractive
        thread.stackSize = 1 << 20
        thread.start()
    }

    // MARK: clocks and output

    private static func wall() -> UInt64 {
        var tv = timeval()
        gettimeofday(&tv, nil)
        return UInt64(tv.tv_sec) * 1000 + UInt64(tv.tv_usec) / 1000
    }

    private static func mono() -> UInt64 { clock_gettime_nsec_np(CLOCK_UPTIME_RAW) / 1_000_000 }

    private static func line(_ text: String) {
        guard fd >= 0 else { return }
        let bytes = Array("\(wall()) \(text)\n".utf8)
        bytes.withUnsafeBufferPointer { _ = write(fd, $0.baseAddress, $0.count) }
    }

    /// Every loaded image with its load address, for symbolizing offline.
    private static func images() {
        var out = "IMAGES"
        for i in 0..<_dyld_image_count() {
            guard let header = _dyld_get_image_header(i), let name = _dyld_get_image_name(i) else { continue }
            out += "\n  0x\(String(UInt(bitPattern: header), radix: 16)) \(String(cString: name))"
        }
        line(out)
    }

    // MARK: the loop

    private static func loop() {
        selfPort = pthread_mach_thread_np(pthread_self())
        var seq: UInt64 = 0
        var sent = [UInt64](repeating: 0, count: 4096)
        var lastIteration = mono()
        var lastBeat: UInt64 = 0
        var lastMainSample: UInt64 = 0
        var lastAllSample: UInt64 = 0
        var stallStart: UInt64 = 0
        var stallSamples = 0
        var windowEnd: UInt64 = 0
        var windowName = ""
        var lastWindowCheck: UInt64 = 0
        var previousStack: [UInt64] = []
        warmUp()
        while true {
            usleep(20_000)
            let now = mono()
            if now - lastIteration > 300 {
                line("HELD the watchdog itself did not run for \(now - lastIteration) ms")
            }
            lastIteration = now

            seq += 1
            sent[Int(seq % 4096)] = now
            let mine = seq
            DispatchQueue.main.async {
                let at = clock_gettime_nsec_np(CLOCK_UPTIME_RAW) / 1_000_000
                StallWatch.pong.withLock { $0 = (seq: max($0.seq, mine), at: at) }
            }
            let answered = pong.withLock { $0 }
            let oldest = answered.seq + 1 < seq ? sent[Int((answered.seq + 1) % 4096)] : now
            let late = now - min(oldest, now)

            if now - lastWindowCheck >= 50 {
                lastWindowCheck = now
                let request = dir + "/stallwatch-window.req"
                if access(request, F_OK) == 0 {
                    windowName = (try? String(contentsOfFile: request, encoding: .utf8))?
                        .trimmingCharacters(in: .whitespacesAndNewlines) ?? "?"
                    rename(request, dir + "/stallwatch-window-\(windowName).taken")
                    windowEnd = now + window
                    previousStack = []
                    line("WINDOW OPEN \(windowName) for \(window) ms")
                }
            }
            let inWindow = now < windowEnd
            if !inWindow && windowEnd != 0 {
                line("WINDOW CLOSED \(windowName)")
                windowEnd = 0
            }

            if late > 250 {
                if stallStart == 0 {
                    stallStart = now
                    stallSamples = 0
                    line("STALL BEGIN main queue late by \(late) ms (ping \(answered.seq + 1) of \(seq))")
                }
            } else if stallStart != 0 {
                line("STALL END after about \(now - stallStart + 250) ms, \(stallSamples) main samples")
                stallStart = 0
                previousStack = []
            }

            let wantMain = (stallStart != 0 && stallSamples < 400) || inWindow
            if wantMain && now - lastMainSample >= 100 {
                lastMainSample = now
                if stallStart != 0 { stallSamples += 1 }
                let stack = sample(mainPort)
                let info = basic(mainPort)
                let tag = stallStart != 0 ? "MAIN-STALL" : "MAIN"
                if stack == previousStack {
                    line("\(tag) late=\(late) \(info) same stack")
                } else {
                    line("\(tag) late=\(late) \(info)\n" + render(stack))
                    previousStack = stack
                }
            }
            if inWindow && now - lastAllSample >= 2000 {
                lastAllSample = now
                allThreads(late: late)
            }
            if now - lastBeat >= 1000 {
                lastBeat = now
                var usage = rusage()
                getrusage(RUSAGE_SELF, &usage)
                let cpu = Double(usage.ru_utime.tv_sec + usage.ru_stime.tv_sec)
                    + Double(usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1_000_000
                line("HB mono=\(now) late=\(late) pongs=\(answered.seq) cpu=\(String(format: "%.2f", cpu))s main: \(basic(mainPort))")
            }
        }
    }

    // MARK: stacks

    /// Suspend the thread, read its registers and walk its frame pointers into the preallocated buffer, resume it.
    /// Nothing between suspend and resume allocates or takes a lock.
    private static func sample(_ thread: thread_act_t) -> [UInt64] {
        // Everything the suspended section touches is read into locals first: a static's first read can allocate.
        // The registers are read as the raw words of the thread state, so no field name of the C struct matters:
        // ARM_THREAD_STATE64 (6) is x0-x28, fp, lr, sp, pc (68 words of 32 bits); x86_THREAD_STATE64 (4) has rbp at
        // 6 and rip at 16 (42 words).
        let buffer = frames
        let registers = state
        let limit = maxFrames
        let task = mach_task_self_
        guard thread != selfPort, thread_suspend(thread) == KERN_SUCCESS else { return [] }
        var n = 0
        var fp: UInt64 = 0
        #if arch(arm64)
        var count = mach_msg_type_number_t(68)
        let kr = registers.withMemoryRebound(to: natural_t.self, capacity: 80) {
            thread_get_state(thread, thread_state_flavor_t(6), $0, &count)
        }
        if kr == KERN_SUCCESS {
            buffer[0] = registers[32]  // pc
            buffer[1] = registers[30]  // lr
            n = 2
            fp = registers[29]
        }
        #elseif arch(x86_64)
        var count = mach_msg_type_number_t(42)
        let kr = registers.withMemoryRebound(to: natural_t.self, capacity: 80) {
            thread_get_state(thread, thread_state_flavor_t(4), $0, &count)
        }
        if kr == KERN_SUCCESS {
            buffer[0] = registers[16]  // rip
            n = 1
            fp = registers[6]  // rbp
        }
        #endif
        while n < limit, fp != 0, fp % 8 == 0 {
            var pair: (UInt64, UInt64) = (0, 0)
            var got: vm_size_t = 0
            let read = withUnsafeMutablePointer(to: &pair) { pointer in
                vm_read_overwrite(task, vm_address_t(fp), vm_size_t(16), vm_address_t(UInt(bitPattern: pointer)), &got)
            }
            if read != KERN_SUCCESS || got != 16 || pair.1 == 0 { break }
            buffer[n] = pair.1
            n += 1
            if pair.0 <= fp { break }
            fp = pair.0
        }
        thread_resume(thread)
        return Array(UnsafeBufferPointer(start: buffer, count: n))
    }

    /// The first walk instantiates the runtime's metadata for the types it uses, which allocates. Do it on a thread
    /// of our own that only sleeps, never on one that might hold the allocator's lock while it is suspended.
    private static func warmUp() {
        let ready = DispatchSemaphore(value: 0)
        let port = OSAllocatedUnfairLock(initialState: thread_act_t(0))
        let sleeper = Thread {
            port.withLock { $0 = pthread_mach_thread_np(pthread_self()) }
            ready.signal()
            while true { sleep(3600) }
        }
        sleeper.name = "probe.stallwatch.warmup"
        sleeper.start()
        ready.wait()
        usleep(50_000)
        let stack = sample(port.withLock { $0 })
        line("WARMUP walked \(stack.count) frames of a sleeping thread")
    }

    private static func render(_ stack: [UInt64]) -> String {
        if stack.isEmpty { return "  (no stack)" }
        return stack.enumerated().map { index, address in
            "  #\(index) 0x\(String(address, radix: 16)) \(symbol(index == 0 ? address : address &- 1))"
        }.joined(separator: "\n")
    }

    private static func symbol(_ address: UInt64) -> String {
        if let known = symbols[address] { return known }
        var info = Dl_info()
        var text = "?"
        if dladdr(UnsafeRawPointer(bitPattern: UInt(address)), &info) != 0 {
            let image = info.dli_fname.map { (String(cString: $0) as NSString).lastPathComponent } ?? "?"
            let base = UInt64(UInt(bitPattern: info.dli_fbase))
            text = "\(image)+0x\(String(address &- base, radix: 16))"
            if let name = info.dli_sname {
                let start = UInt64(UInt(bitPattern: info.dli_saddr))
                text += " \(String(cString: name))+\(address &- start)"
            }
        }
        symbols[address] = text
        return text
    }

    /// Run state, CPU and suspend count of one thread, as the kernel reports them.
    private static func basic(_ thread: thread_act_t) -> String {
        var info = thread_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<thread_basic_info>.size / MemoryLayout<natural_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                thread_info(thread, thread_flavor_t(THREAD_BASIC_INFO), $0, &count)
            }
        }
        guard kr == KERN_SUCCESS else { return "state=? (\(kr))" }
        let states = [1: "running", 2: "stopped", 3: "waiting", 4: "uninterruptible", 5: "halted"]
        let user = Double(info.user_time.seconds) + Double(info.user_time.microseconds) / 1_000_000
        let system = Double(info.system_time.seconds) + Double(info.system_time.microseconds) / 1_000_000
        return "state=\(states[Int(info.run_state)] ?? "\(info.run_state)") cpu=\(Double(info.cpu_usage) / 10)% "
            + "suspend=\(info.suspend_count) user=\(String(format: "%.2f", user))s sys=\(String(format: "%.2f", system))s"
    }

    private static func name(_ thread: thread_act_t) -> String {
        guard let handle = pthread_from_mach_thread_np(thread) else { return "" }
        var buffer = [CChar](repeating: 0, count: 128)
        pthread_getname_np(handle, &buffer, buffer.count)
        return String(cString: buffer)
    }

    private static func allThreads(late: UInt64) {
        var list: thread_act_array_t?
        var count: mach_msg_type_number_t = 0
        guard task_threads(mach_task_self_, &list, &count) == KERN_SUCCESS, let threads = list else { return }
        var out = "ALL late=\(late) threads=\(count)"
        for index in 0..<Int(count) {
            let thread = threads[index]
            let label = thread == mainPort ? "MAIN" : (thread == selfPort ? "watchdog" : name(thread))
            out += "\n THREAD \(index) port=\(thread) \"\(label)\" \(basic(thread))"
            if thread != selfPort { out += "\n" + render(sample(thread)) }
        }
        line(out)
        for index in 0..<Int(count) { mach_port_deallocate(mach_task_self_, threads[index]) }
        vm_deallocate(mach_task_self_, vm_address_t(UInt(bitPattern: threads)),
                      vm_size_t(Int(count) * MemoryLayout<thread_act_t>.stride))
    }
}
