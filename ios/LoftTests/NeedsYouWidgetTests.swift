import SwiftUI
import XCTest
@testable import Loft
@testable import LoftKit

/// The Needs you widget (spec #462): its items, Approve and Deny against a fake API, and its states drawn.
/// `WIDGET_SHOTS=<folder>` also writes each drawing there as a PNG, for screenshots.
final class NeedsYouWidgetTests: XCTestCase {
    private func load(_ api: FixtureAPI) async -> WidgetSnapshot {
        await WidgetSnapshot.load(needsYou: api.needsYou, agents: api.agents, permissions: api.permissions, weekSpend: { 12.4 })
    }

    func testItListsTheItemsInTheServersOrderWithTheAgentAndASummary() async throws {
        let api = FixtureAPI()
        let list = try await api.needsYou()
        let s = await load(api)
        XCTAssertEqual(s.items.map(\.id), Array(list.items.prefix(WidgetSnapshot.itemLimit).map(\.id)))
        let permission = try XCTUnwrap(s.items.first { $0.id == "permission:p1" })
        XCTAssertEqual(permission.agentName, "Backend Agent")
        XCTAssertEqual(permission.summary, "Push the fix", "a permission's summary is what it's for, not \"Waiting for your approval.\"")
        let question = try XCTUnwrap(s.items.first { list.items.first(where: { $0.type == "question" })?.id == $0.id })
        XCTAssertEqual(question.summary, "Should I use B2 or S3?")
    }

    func testOnlyPermissionsGetApproveAndDenyAndAQuestionOpensItsChat() async throws {
        let api = FixtureAPI()
        let list = try await api.needsYou()
        let s = await load(api)
        for item in s.items {
            let type = try XCTUnwrap(list.items.first { $0.id == item.id }).type
            XCTAssertEqual(item.approve != nil, type == "permission", item.id)
            XCTAssertEqual(item.deny != nil, type == "permission", item.id)
        }
        let p = try XCTUnwrap(s.items.first { $0.approve != nil })
        XCTAssertEqual(p.approve?.body?["decision"], .string("allow_once"), "Approve is Allow once, never Always allow")
        XCTAssertEqual(p.deny?.body?["decision"], .string("deny"))
        let question = try XCTUnwrap(list.items.first { $0.type == "question" })
        XCTAssertEqual(s.items.first { $0.id == question.id }?.link, .agent(try XCTUnwrap(question.openAction?.target?.agentId)))
    }

    func testTheIntentsSendTheItemsOwnActions() async throws {
        let loaded = await load(FixtureAPI())
        let p = try XCTUnwrap(loaded.items.first { $0.approve != nil })
        var sent: [(String, String, JSONValue?)] = []
        for action in [p.approve, p.deny].compactMap({ $0 }) {
            try await NeedsYouDecisionIntent(action).send { sent.append(($0, $1, $2)) }
        }
        XCTAssertEqual(sent.map(\.0), ["POST", "POST"])
        XCTAssertEqual(sent.map(\.1), ["/api/permissions/p1", "/api/permissions/p1"])
        XCTAssertEqual(sent.map(\.2), [p.approve?.body, p.deny?.body])
    }

    func testAnApprovedItemIsGoneAfterTheReload() async throws {
        let api = FixtureAPI()
        let before = await load(api)
        let p = try XCTUnwrap(before.items.first { $0.approve != nil })
        try await NeedsYouDecisionIntent(try XCTUnwrap(p.approve)).send(api.needsYouRequest)
        let after = await load(api)
        XCTAssertFalse(after.items.contains { $0.id == p.id })
        let count = try await api.needsYou().count
        XCTAssertEqual(after.needsCount, count)
    }

    func testAFailedRequestThrowsSoTheWidgetKeepsTheItem() async throws {
        let loaded = await load(FixtureAPI())
        let p = try XCTUnwrap(loaded.items.first { $0.deny != nil })
        let offline = FixtureAPI(mode: .offline)
        do {
            try await NeedsYouDecisionIntent(try XCTUnwrap(p.deny)).send(offline.needsYouRequest)
            XCTFail("an offline Loft fails the intent")
        } catch {}
        let s = await load(offline)
        XCTAssertEqual(s.phase, .unreachable)
    }

    @MainActor
    func testEveryStateDrawsAndTheStatesLookDifferent() async throws {
        let ready = await load(FixtureAPI())
        let empty = WidgetSnapshot(needsYou: NeedsYouList(version: 1, count: 0, urgent: 0, items: []), agents: [], weekSpend: nil)
        let states: [(String, WidgetSnapshot)] = [("ready", ready), ("empty", empty), ("not-connected", .notConnected), ("unreachable", .unreachable)]
        var seen: [Data] = []
        for (name, snapshot) in states {
            for (size, points) in [(NeedsYouWidgetView.Size.medium, CGSize(width: 338, height: 158)), (.large, CGSize(width: 338, height: 354))] {
                let view = NeedsYouWidgetView(snapshot, size: size).padding(16).frame(width: points.width, height: points.height)
                    .background(Color(white: 0.11)).environment(\.colorScheme, .dark).environment(\.widgetLinksTap, false)
                let renderer = ImageRenderer(content: view)
                renderer.scale = 2
                let png = try XCTUnwrap(renderer.uiImage?.pngData(), "\(name) \(size)")
                seen.append(png)
                if let dir = ProcessInfo.processInfo.environment["WIDGET_SHOTS"] {
                    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
                    try png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("ios-needs-you-\(name)-\(size).png"))
                }
            }
        }
        XCTAssertEqual(Set(seen).count, seen.count, "no two states or sizes draw the same")
    }
}
