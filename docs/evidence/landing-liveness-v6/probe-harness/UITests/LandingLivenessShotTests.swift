import XCTest

// TEMPORARY evidence probe (see ../README.md). The Work overview's Landing card head — the shared
// head the six surfaces wear — photographed on the iPhone against stub.py, once per §7.2 V6
// reading: LIVE, SILENT, LEGACY, the server's timeout, and a server that sends no new fields.
//
// The stub's mode is set before each launch; its `/__reset` (which `launch` posts) keeps the mode.
final class LandingLivenessShotTests: ProbeCase {
    #if os(iOS)
    func testIPhoneShowsTheLandingHeadsLiveness() {
        let readings: [(mode: String, needle: String)] = [
            ("live", "output 6s ago"),
            ("silent", "no word from runner wikova for 4m"),
            ("legacy", "reports only between steps"),
            ("timed-out", "No report for 23m"),
            ("older", "updated just now"),
        ]
        for reading in readings {
            setMode(reading.mode)
            let app = launch(until: "Landing", extra: ["-probe.project"], reading.mode)
            XCTAssertTrue(appears(app, reading.needle, timeout: 45),
                          "\(reading.mode): the head's liveness line never showed")
            // The card is the Work overview's first block; bring the line into the picture when
            // the phone's page has scrolled or the header pushed it down.
            bring(app, element(app, containing: reading.needle), between: 70, and: 780, reading.mode)
            shot(app, "ios-\(reading.mode)")
            app.terminate()
            settle(1)
        }
    }
    #endif

    private func setMode(_ mode: String) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8765/__mode/\(mode)")!)
        request.timeoutInterval = 10
        let answered = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { _, _, _ in answered.signal() }.resume()
        _ = answered.wait(timeout: .now() + 15)
    }
}
