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
      gmail.tap(); sleep(1) // unpick again: create with the pre-selected default store
    }
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

  func testWalkthrough() {
    continueAfterFailure = true
    var r: [String] = []
    XCUIDevice.shared.appearance = .light
    r += walk("light")
    XCUIDevice.shared.appearance = .dark
    r += walk("dark")
    note("00-results", r.joined(separator: "\n"))
  }
}
