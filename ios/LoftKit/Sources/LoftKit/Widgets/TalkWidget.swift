import AppIntents
import SwiftUI
import WidgetKit

/// Opens `loft://talk`: the Talk control's tap. The app starts listening (iPhone) or opens Talk (Mac).
@available(iOS 18.0, macOS 26.0, *)
public struct OpenTalkIntent: AppIntent {
    public static let title: LocalizedStringResource = "Talk to Loft"
    public static let description = IntentDescription("Start talking to Loft.")
    public static let isDiscoverable = false

    public init() {}

    public func perform() async throws -> some IntentResult & OpensIntent { .result(opensIntent: OpenURLIntent(DeepLink.talk.url)) }
}

/// The Talk control (spec #462): Control Center and the Lock Screen on the iPhone, Control Center on the Mac.
@available(iOS 18.0, macOS 26.0, *)
public struct TalkControl: ControlWidget {
    public init() {}

    public var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "loft.talk.control") {
            ControlWidgetButton(action: OpenTalkIntent()) { Label("Talk to Loft", systemImage: "mic.fill") }
        }
        .displayName("Talk to Loft")
        .description("Start talking to Loft.")
    }
}

struct TalkEntry: TimelineEntry { let date: Date }

/// Nothing to read: the widget is a button.
struct TalkProvider: TimelineProvider {
    func placeholder(in context: Context) -> TalkEntry { TalkEntry(date: .now) }
    func getSnapshot(in context: Context, completion: @escaping (TalkEntry) -> Void) { completion(TalkEntry(date: .now)) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<TalkEntry>) -> Void) {
        completion(Timeline(entries: [TalkEntry(date: .now)], policy: .never))
    }
}

/// The one-tap Talk widget (spec #462): small on the Home Screen and the desktop, round on the Lock Screen.
public struct TalkWidget: Widget {
    public init() {}

    public var body: some WidgetConfiguration {
        StaticConfiguration(kind: "loft.talk", provider: TalkProvider()) { _ in
            TalkEntryView()
                .containerBackground(.background, for: .widget)
                .widgetURL(DeepLink.talk.url)
        }
        .configurationDisplayName("Talk")
        .description("One tap to start talking to Loft.")
        .supportedFamilies(Self.families)
    }

    static var families: [WidgetFamily] {
        #if os(iOS)
        [.systemSmall, .accessoryCircular]
        #else
        [.systemSmall]
        #endif
    }
}

private struct TalkEntryView: View {
    @Environment(\.widgetFamily) private var family

    var body: some View { TalkWidgetView(round: family != .systemSmall) }
}

/// A mic in the accent circle and "Talk to Loft"; on the Lock Screen (`round`), just the mic.
struct TalkWidgetView: View {
    let round: Bool

    var body: some View {
        if !round {
            VStack(spacing: 10) {
                mic.frame(width: 64, height: 64).background(Theme.accent, in: Circle())
                Text("Talk to Loft").font(.headline)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ZStack {
                AccessoryWidgetBackground()
                mic
            }
            .accessibilityLabel("Talk to Loft")
        }
    }

    private var mic: some View {
        Image(systemName: "mic.fill")
            .font(.title.weight(.semibold))
            .foregroundStyle(round ? AnyShapeStyle(.primary) : AnyShapeStyle(Theme.onAccent))
    }
}
