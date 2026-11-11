import AppKit
import SwiftUI
import XCTest
@testable import LoftKit

/// The widgets drawn on the Mac, on fixture data (the iPhone's are in LoftTests/WidgetSnapshotTests).
/// `WIDGET_SHOTS=<folder>` also writes each drawing there as a PNG, for screenshots.
@MainActor
final class WidgetRenderTests: XCTestCase {
    func testEveryStateDrawsAtBothSizesAndTheStatesLookDifferent() async throws {
        let api = FixtureAPI()
        let ready = WidgetSnapshot(needsYou: try await api.needsYou(), agents: try await api.agents(), weekSpend: 12.4)
        var seen: [Data] = []
        for (name, snapshot) in [("ready", ready), ("not-paired", WidgetSnapshot.notPaired), ("unreachable", .unreachable)] {
            for (size, points) in [(LoftWidgetView.Size.small, CGSize(width: 158, height: 158)), (.medium, CGSize(width: 338, height: 158))] {
                let view = LoftWidgetView(snapshot, size: size).padding(16).frame(width: points.width, height: points.height)
                    .background(Color(white: 0.11)).environment(\.colorScheme, .dark).environment(\.widgetLinksTap, false)
                let renderer = ImageRenderer(content: view)
                renderer.scale = 2
                let tiff = try XCTUnwrap(renderer.nsImage?.tiffRepresentation, "\(name) \(size)")
                let png = try XCTUnwrap(NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]))
                seen.append(png)
                if let dir = ProcessInfo.processInfo.environment["WIDGET_SHOTS"] {
                    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
                    try png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("mac-\(name)-\(size).png"))
                }
            }
        }
        XCTAssertEqual(Set(seen).count, seen.count, "no two states or sizes draw the same")
    }
}
