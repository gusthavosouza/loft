import XCTest
@testable import LoftKit

/// What the Mac's Talk sheet does as the voice session moves on, and where a denied permission leads (spec #382).
final class TalkHandOffTests: XCTestCase {
    func testTheSheetStaysWhileListeningTidyingOrFailed() {
        for p: VoiceSession.Phase in [.idle, .preparing, .listening, .paused, .cleaning, .failed("x")] {
            XCTAssertEqual(TalkHandOff.outcome(phase: p, autoSendAt: nil), .stay, "\(p)")
        }
    }

    func testTidiedTextGoesToTheChatBox() {
        XCTAssertEqual(TalkHandOff.outcome(phase: .review, autoSendAt: nil), .textToChat)
        XCTAssertEqual(TalkHandOff.outcome(phase: .review, autoSendAt: Date()), .stay, "a countdown send isn't ours to take")
    }

    /// Send, or a spoken "send", takes the sheet to the chat; it no longer sits on "Start talking…".
    func testASentMessageTakesTheSheetToTheChat() {
        for p: VoiceSession.Phase in [.sending, .speaking, .replied] {
            XCTAssertEqual(TalkHandOff.outcome(phase: p, autoSendAt: nil), .sentToChat, "\(p)")
        }
    }

    func testClosingKeepsTheReplyBeingReadButDropsADictation() {
        XCTAssertFalse(TalkHandOff.discardsOnClose(.speaking))
        XCTAssertFalse(TalkHandOff.discardsOnClose(.sending))
        XCTAssertTrue(TalkHandOff.discardsOnClose(.listening))
        XCTAssertTrue(TalkHandOff.discardsOnClose(.review))
    }

    func testTheRightPrivacyPaneOpens() {
        XCTAssertEqual(TalkHandOff.privacyPane(for: "Microphone access is off for Loft."), "Privacy_Microphone")
        XCTAssertEqual(TalkHandOff.privacyPane(for: "Speech recognition is off for Loft."), "Privacy_SpeechRecognition")
    }
}
