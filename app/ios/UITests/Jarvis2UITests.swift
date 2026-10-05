import XCTest

/// Walks Jarvis 2 on a simulator against the mock backend and keeps screenshots of every step
/// (light, then dark). Soft steps: one run records everything it can.
final class Jarvis2UITests: XCTestCase {
  let app = XCUIApplication()

  func shot(_ name: String) {
    let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    a.name = name; a.lifetime = .keepAlways; add(a)
  }
  func note(_ name: String, _ text: String) {
    let a = XCTAttachment(string: text); a.name = name; a.lifetime = .keepAlways; add(a)
  }
  func el(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }

  func walk(_ tag: String) -> [String] {
    var r: [String] = []
    let t0 = Date()
    app.launch()
    let listUp = el("newBtn").waitForExistence(timeout: 120)
    r.append("[\(tag)] list up: \(listUp) after \(String(format: "%.1f", Date().timeIntervalSince(t0)))s")
    sleep(3)
    shot("\(tag)-01-sessions")
    if !listUp { note("\(tag)-tree", app.debugDescription); return r }

    el("newBtn").tap()
    sleep(3)
    shot("\(tag)-02-new-session-form")
    let start = el("ns-start")
    r.append("[\(tag)] form start button: \(start.waitForExistence(timeout: 10))")
    start.tap()
    for i in 0..<3 { shot("\(tag)-03-entering-\(i)"); usleep(120_000) }
    let sheet = el("secure-create").waitForExistence(timeout: 15)
    r.append("[\(tag)] secure sheet: \(sheet); React Native list still in tree: \(el("newBtn").exists)")
    sleep(2)
    shot("\(tag)-04-secure-sheet")
    let gmail = el("secure-store-gmail")
    if gmail.waitForExistence(timeout: 10) {
      gmail.tap(); sleep(1)
      r.append("[\(tag)] sensitive warning: \(el("secure-sensitive-warning").exists)")
      shot("\(tag)-05-sensitive-picked")
    }
    // Back pops the shell's page and returns to the React Native form as it was
    el("secure-back").tap()
    for i in 0..<3 { shot("\(tag)-05b-back-\(i)"); usleep(120_000) }
    let formAgain = el("ns-start").waitForExistence(timeout: 10)
    r.append("[\(tag)] Back returned to the form: \(formAgain)")
    sleep(1)
    shot("\(tag)-05c-form-again")
    el("ns-start").tap()
    _ = el("secure-create").waitForExistence(timeout: 15)
    sleep(2)
    el("secure-create").tap()
    let back = el("newBtn").waitForExistence(timeout: 40)
    r.append("[\(tag)] back to the list after create: \(back); error shown: \(el("secure-error").exists)")
    if el("secure-error").exists { r.append("[\(tag)] error: \(el("secure-error").label)"); shot("\(tag)-06-error") }
    for i in 0..<3 { shot("\(tag)-06-leaving-\(i)"); usleep(120_000) }
    sleep(6)
    shot("\(tag)-07-sessions-after")
    app.terminate()
    return r
  }

  /// CI sets the simulator's appearance (simctl ui … appearance) and runs this once per appearance;
  /// JARVIS2_APPEARANCE names the pass in the screenshots
  func testWalkthrough() {
    continueAfterFailure = true
    let tag = ProcessInfo.processInfo.environment["JARVIS2_APPEARANCE"] ?? "run"
    note("00-results-\(tag)", walk(tag).joined(separator: "\n"))
  }
}
