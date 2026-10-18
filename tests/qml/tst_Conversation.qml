import QtQuick
import QtTest

TestCase {
    id: test
    name: "Conversation"
    visible: true
    width: 448
    height: 640
    when: windowShown

    SignalSpy { id: closeSpy; signalName: "closeRequested" }

    function test_plain_text_keyboard_and_scroll() {
        const component = Qt.createComponent(Qt.resolvedUrl("../../desktop/Conversation.qml"))
        compare(component.status, Component.Ready, component.errorString())
        const content = createTemporaryObject(component, this, {
            width: 448, height: 640, background: "#121212", ink: "#bebebe",
            accentInk: "#e68e0d", troubleInk: "#D35F5F",
            statusSentence: "Idle. Microphone in use.", currentState: "idle"
        })
        verify(content !== null)
        closeSpy.target = content
        closeSpy.clear()
        const close = findChild(content, "closeConversation")
        const transcript = findChild(content, "transcript")
        verify(close !== null && transcript !== null)
        compare(close.width, 33)
        compare(close.height, 33)
        compare(close.Accessible.name, "Close conversation")
        compare(close.Accessible.role, Accessible.Button)
        compare(transcript.Accessible.role, Accessible.Document)
        content.focusClose()
        verify(close.activeFocus)
        keyClick(Qt.Key_Tab)
        verify(transcript.activeFocus)
        keyClick(Qt.Key_Backtab)
        verify(close.activeFocus)
        keyClick(Qt.Key_Return)
        compare(closeSpy.count, 1)
        keyClick(Qt.Key_Space)
        compare(closeSpy.count, 2)
        mouseClick(close)
        compare(closeSpy.count, 3)
        keyClick(Qt.Key_Escape)
        compare(closeSpy.count, 4)
        const literal = '<b>Literal text</b> https://example.invalid ' + "unbroken".repeat(80)
        const turns = [{speaker: "you", text: literal, state: "complete"}]
        for (let i = 0; i < 18; i++) turns.push({speaker: "kestrel", text: "Literal reply " + i + ".", state: "complete"})
        content.turns = turns
        tryVerify(function() { return transcript.contentHeight > transcript.height })
        const body = findChild(content, "turnText0")
        verify(body !== null)
        compare(body.text, literal)
        compare(body.textFormat, Text.PlainText)
        compare(body.wrapMode, Text.Wrap)
        verify(body.lineCount > 1)
        compare(body.font.pixelSize, 14)
        compare(body.lineHeight, 21)
        compare(body.parent.x, 32)
        compare(body.parent.Accessible.name, "You: " + literal)
        tryVerify(function() { return transcript.atYEnd })
        transcript.forceActiveFocus()
        keyClick(Qt.Key_Home)
        compare(transcript.contentY, 0)
        keyClick(Qt.Key_Down)
        compare(transcript.contentY, 21)
        keyClick(Qt.Key_Up)
        compare(transcript.contentY, 0)
        keyClick(Qt.Key_PageDown)
        verify(transcript.contentY > 21)
        keyClick(Qt.Key_PageUp)
        compare(transcript.contentY, 0)
        const more = turns.concat([{speaker: "kestrel", text: "New terminal reply.", state: "interrupted"}])
        content.turns = more
        verify(waitForRendering(content))
        tryVerify(function() { return findChild(content, "turnText19") !== null })
        compare(transcript.contentY, 0, "reading older turns must not jump on new content")
        keyClick(Qt.Key_End)
        verify(transcript.atYEnd, "End: y=" + transcript.contentY + " height=" + transcript.contentHeight + " viewport=" + transcript.height + " focus=" + transcript.activeFocus)
        content.turns = more.concat([{speaker: "kestrel", text: "Final terminal reply.", state: "failed"}])
        verify(waitForRendering(content))
        tryVerify(function() { return findChild(content, "turnText20") !== null && transcript.atYEnd })
        compare(findChild(content, "turnNotice19").text, "Reply interrupted.")
        compare(findChild(content, "turnNotice20").text, "Reply could not be completed.")
        keyClick(Qt.Key_Escape)
        compare(closeSpy.count, 5)
        keyClick(Qt.Key_Tab)
        verify(close.activeFocus)
        keyClick(Qt.Key_Backtab)
        verify(transcript.activeFocus)
        closeSpy.target = null
        component.destroy()
    }
}
