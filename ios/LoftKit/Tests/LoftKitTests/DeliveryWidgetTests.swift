import AppKit
import SwiftUI
import XCTest
@testable import LoftKit

/// The Delivery progress widget (spec #462): the Deliveries it offers, what it shows for one, and its states drawn on
/// the Mac. `WIDGET_SHOTS=<folder>` also writes each drawing there as a PNG, for screenshots.
final class DeliveryWidgetTests: XCTestCase {
    private func spec(_ id: String, _ title: String, _ number: Int?, updated: TimeInterval = 0) -> HBTask {
        var t = HBTask(id: id, title: title, description: "", kind: "work", status: "in_progress", priority: "medium", project: "loft",
                       agentId: nil, parentId: nil, dependsOn: [], dueAt: nil, createdBy: "user", note: "", summary: "", error: "",
                       createdAt: .now, updatedAt: .now.addingTimeInterval(updated), startedAt: nil, completedAt: nil)
        t.labels = ["spec"]
        t.github = number.map { .init(repo: "o/loft", number: $0, url: "", state: "open") }
        return t
    }

    private func ticket(_ n: Int, _ state: String, agent: String? = nil) -> DeliverySummary.Ticket {
        .init(number: n, title: "Ticket \(n)", state: state, agentName: agent)
    }

    private func delivery(_ spec: Int, _ state: String, tickets: [DeliverySummary.Ticket] = [], pr: Int? = nil) -> DeliverySummary {
        DeliverySummary(state: state, agentName: nil, repo: "o/loft", spec: spec, specId: nil, local: false, pr: pr, current: nil, tickets: tickets)
    }

    private func pr(_ number: Int, _ labels: [String]) -> PullRequest {
        PullRequest(id: "p\(number)", agentId: "dev", slug: "o/loft", number: number, url: "", title: "Spec", state: "open", draft: true,
                    createdAt: nil, labels: labels)
    }

    func testThePickerOffersStartedDeliveriesTheRunningOnesFirstThenTheLatest() {
        let tasks = [spec("a", "Old done", 10, updated: -500), spec("b", "Running", 20, updated: -900), spec("c", "New done", 30, updated: -10),
                     spec("d", "Planned", 40)]
        let ds = [delivery(10, "merged"), delivery(20, "running"), delivery(30, "ready"), delivery(40, "planned"),
                  DeliverySummary(state: "stalled", agentName: nil, repo: "loft:garden", spec: 1, specId: "g", local: true, current: nil, tickets: [])]
        let offered = DeliveryWidgetSnapshot.choices(ds, tasks: tasks + [spec("g", "Garden notes", nil, updated: -2000)])
        XCTAssertEqual(offered.map(\.title), ["#20 Running", "Garden notes", "#30 New done", "#10 Old done"])
        XCTAssertEqual(offered.map(\.key), ["o/loft#20", "id:g", "o/loft#30", "o/loft#10"])
    }

    func testARunningDeliveryShowsProgressTheTicketBeingBuiltItsDevAndTheVerdicts() {
        let d = delivery(462, "running", tickets: [ticket(464, "closed"), ticket(465, "closed"), ticket(466, "started", agent: "Loft Dev"),
                                                  ticket(467, "open"), ticket(9, "elsewhere")], pr: 463)
        let s = DeliveryWidgetSnapshot(key: "o/loft#462", title: "", deliveries: [d], tasks: [spec("w", "Widgets", 462)],
                                       pullRequests: [pr(463, ["qa:passed", "security:findings"]), pr(1, ["qa:failed"])])
        XCTAssertEqual(s.phase, .ready)
        XCTAssertEqual(s.title, "#462 Widgets")
        XCTAssertEqual(s.status, .running)
        XCTAssertEqual(s.done, 2)
        XCTAssertEqual(s.total, 4, "a ticket built elsewhere doesn't count")
        XCTAssertEqual(s.ticket, "#466 Ticket 466")
        XCTAssertEqual(s.dev, "Loft Dev")
        XCTAssertEqual([s.review, s.qa, s.security], [.pending, .passed, .failed])
        XCTAssertEqual(s.link, .issue("w"))
    }

    func testFinishedStalledAndWaitingDeliveriesSaySo() {
        func status(_ d: DeliverySummary) -> DeliveryWidgetSnapshot {
            DeliveryWidgetSnapshot(key: DeliveryWidgetSnapshot.key(d), title: "", deliveries: [d], tasks: [], pullRequests: [])
        }
        let done = status(delivery(1, "ready", tickets: [ticket(2, "closed")]))
        XCTAssertEqual(done.status, .done)
        XCTAssertTrue(done.status.finished)
        XCTAssertEqual(done.review, .passed)
        XCTAssertNil(done.ticket)
        XCTAssertEqual(done.done, done.total)
        XCTAssertEqual(status(delivery(1, "merged")).status, .merged)
        XCTAssertEqual(status(delivery(1, "stalled")).status, .stalled)
        XCTAssertEqual(status(delivery(1, "final_fixes")).review, .failed)
        var waiting = delivery(1, "running", tickets: [ticket(2, "needs_human")])
        waiting.waitingOnYou = [2]
        XCTAssertEqual(status(waiting).status, .needsYou)
        XCTAssertEqual(status(delivery(1, "running")).title, "#1", "without its issue, the spec's number")
        XCTAssertEqual(status(delivery(1, "running")).link, .agents)
    }

    func testAGoneDeliveryKeepsTheTitleTheWidgetLastShowed() async throws {
        let titles = try XCTUnwrap(UserDefaults(suiteName: "DeliveryWidgetTests"))
        titles.removePersistentDomain(forName: "DeliveryWidgetTests")
        var ds = [delivery(462, "running")]
        func load() async -> DeliveryWidgetSnapshot {
            await DeliveryWidgetSnapshot.load(key: "o/loft#462", title: "", deliveries: { ds }, tasks: { [self.spec("w", "Widgets", 462)] },
                                              pullRequests: { [] }, titles: titles)
        }
        _ = await load()
        ds = []
        let s = await load()
        XCTAssertEqual(s.phase, .gone)
        XCTAssertEqual(s.title, "#462 Widgets")
    }

    func testOfflineIsUnreachableAndTheExtrasFailingLeaveThemOut() async {
        struct Down: Error {}
        let offline = await DeliveryWidgetSnapshot.load(key: "o/loft#1", title: "#1 X", deliveries: { throw Down() }, tasks: { [] }, pullRequests: { [] })
        XCTAssertEqual(offline.phase, .unreachable)
        XCTAssertEqual(offline.title, "#1 X")
        let s = await DeliveryWidgetSnapshot.load(key: "o/loft#1", title: "", deliveries: { [self.delivery(1, "running", pr: 2)] },
                                                  tasks: { throw Down() }, pullRequests: { throw Down() })
        XCTAssertEqual(s.phase, .ready)
        XCTAssertEqual(s.qa, .pending)
    }

    func testATapOpensTheSpec() {
        XCTAssertEqual(DeepLink(url: DeepLink.issue("w").url), .issue("w"))
    }

    @MainActor
    func testEveryStateDrawsAndTheStatesLookDifferent() throws {
        let tickets = [ticket(464, "closed"), ticket(465, "closed"), ticket(466, "started", agent: "Loft Dev"), ticket(467, "open")]
        let tasks = [spec("w", "Widgets: Needs you with actions, One agent, Delivery progress, Talk", 462)]
        func ready(_ state: String, _ labels: [String], all: Bool = false) -> DeliveryWidgetSnapshot {
            DeliveryWidgetSnapshot(key: "o/loft#462", title: "", deliveries: [delivery(462, state, tickets: all ? tickets.map { var t = $0; t.state = "closed"; return t } : tickets, pr: 463)],
                                   tasks: tasks, pullRequests: [pr(463, labels)])
        }
        let states: [(String, DeliveryWidgetSnapshot)] = [
            ("running", ready("running", ["qa:passed"])), ("stalled", ready("stalled", [])),
            ("done", ready("ready", ["qa:passed", "security:passed"], all: true)),
            ("gone", DeliveryWidgetSnapshot(phase: .gone, key: "o/loft#462", title: "#462 Widgets")),
            ("not-chosen", DeliveryWidgetSnapshot(phase: .notChosen)),
            ("offline", DeliveryWidgetSnapshot(phase: .unreachable, key: "o/loft#462", title: "#462 Widgets")),
        ]
        var seen: [Data] = []
        for (name, snapshot) in states {
            let view = DeliveryWidgetView(snapshot).padding(16).frame(width: 338, height: 158)
                .background(Color(white: 0.11)).environment(\.colorScheme, .dark)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            let tiff = try XCTUnwrap(renderer.nsImage?.tiffRepresentation, name)
            let png = try XCTUnwrap(NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]))
            seen.append(png)
            if let dir = ProcessInfo.processInfo.environment["WIDGET_SHOTS"] {
                try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
                try png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("mac-delivery-\(name).png"))
            }
        }
        XCTAssertEqual(Set(seen).count, seen.count, "no two states draw the same")
    }
}
