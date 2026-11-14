import AppKit
import SwiftUI
import XCTest
@testable import LoftKit

/// The Talk widget and control (spec #462): the link they open, who Talk starts with, and the widget drawn on the Mac.
/// `WIDGET_SHOTS=<folder>` also writes each drawing there as a PNG, for screenshots.
final class TalkWidgetTests: XCTestCase {
    func testTheTalkLinkRoundTrips() {
        XCTAssertEqual(DeepLink.talk.url.absoluteString, "loft://talk")
        XCTAssertEqual(DeepLink(url: DeepLink.talk.url), .talk)
        XCTAssertEqual(DeepLink(url: URL(string: "loft://talk/")!), .talk)
        XCTAssertNil(DeepLink(url: URL(string: "https://example.com/talk")!))
    }

    func testTalkStartsWithTheLastAgentElseTheOrchestratorElseAsks() async throws {
        let agents = try await FixtureAPI().agents()
        XCTAssertEqual(TalkRecipients.starter(lastAgentId: "qa", orchestratorId: "orch", agents: agents), "qa")
        XCTAssertEqual(TalkRecipients.starter(lastAgentId: nil, orchestratorId: "orch", agents: agents), "orch")
        XCTAssertEqual(TalkRecipients.starter(lastAgentId: "deleted", orchestratorId: "orch", agents: agents), "orch", "a deleted last agent")
        XCTAssertNil(TalkRecipients.starter(lastAgentId: "deleted", orchestratorId: nil, agents: agents))
        XCTAssertNil(TalkRecipients.starter(lastAgentId: "qa", orchestratorId: "orch", agents: []), "no agents loaded yet")
    }

    @MainActor
    func testTheWidgetDrawsSmallAndRound() throws {
        var seen: [Data] = []
        for (name, round, side) in [("small", false, 158.0), ("round", true, 72.0)] {
            let view = TalkWidgetView(round: round).padding(round ? 0 : 16).frame(width: side, height: side)
                .background(Color(white: 0.11)).environment(\.colorScheme, .dark)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            let tiff = try XCTUnwrap(renderer.nsImage?.tiffRepresentation, name)
            let png = try XCTUnwrap(NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]))
            seen.append(png)
            if let dir = ProcessInfo.processInfo.environment["WIDGET_SHOTS"] {
                try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
                try png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("mac-talk-\(name).png"))
            }
        }
        XCTAssertEqual(Set(seen).count, seen.count)
    }
}
