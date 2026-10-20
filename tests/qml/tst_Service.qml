import QtQuick
import QtTest
import "../../desktop" as Desktop

TestCase {
    name: "Service"

    Component { id: serviceComponent; Desktop.Service {} }

    function test_status_input_death_and_silence() {
        const service = createTemporaryObject(serviceComponent, this)
        verify(service !== null)
        compare(service.shell, null)
        compare(service.state, "unavailable")
        const samples = [
            ["A", "starting"], ["I", "idle"], ["L", "listening"],
            ["T", "thinking"], ["S", "speaking"], ["B", "trouble"],
            ["N", "not-running"], ["U", "unavailable"],
            ["AILTSBNUIL", "listening"]
        ]
        for (const sample of samples) {
            service.acceptStatusChunk(sample[0])
            compare(service.state, sample[1])
            if (sample[0] === "B")
                compare(service.statusSentence, "Kestrel needs attention. Microphone in use.")
        }
        for (const invalid of ["", "X", "I\n", "I\u0000", "é", "I private transcript", "I".repeat(33)]) {
            service.acceptStatusChunk("S")
            compare(service.state, "speaking")
            service.acceptStatusChunk(invalid)
            compare(service.state, "unavailable", "invalid chunk must invalidate the previous state")
        }
        service.acceptStatusChunk("I".repeat(32))
        compare(service.state, "idle")
        service.watcherExited()
        compare(service.state, "unavailable")
        service.acceptStatusChunk("L")
        const expiry = findChild(service, "statusExpiry")
        verify(expiry !== null)
        compare(expiry.interval, 3000)
        verify(expiry.running)
        expiry.triggered()
        compare(service.state, "unavailable")
    }

    function test_inactive_status_and_empty_conversation() {
        const service = createTemporaryObject(serviceComponent, this)
        verify(service !== null)
        const snapshot = JSON.stringify({version: 2, session: "inactive-session", turns: []}) + "\n"
        verify(service.acceptConversationChunk(snapshot))
        compare(service.conversationMessage, "Say something. Kestrel replies after you.")
        verify(service.acceptStatusChunk("D"))
        compare(service.state, "inactive")
        compare(service.statusSentence, "Inactive. Microphone in use. Press Super + Shift + K to start.")
        compare(service.conversationAvailable, true)
        compare(service.turns.length, 0)
        compare(service.conversationMessage, "Press Super + Shift + K to start a conversation.")
        for (const wire of ["A", "I"]) {
            verify(service.acceptStatusChunk(wire))
            compare(service.conversationMessage, "Say something. Kestrel replies after you.")
        }
        verify(service.acceptStatusChunk("ID"))
        compare(service.state, "inactive")
        compare(service.conversationMessage, "Press Super + Shift + K to start a conversation.")
        service.conversationExited()
        compare(service.conversationMessage, "Conversation unavailable. Reopen the panel.")
        verify(service.acceptConversationChunk(snapshot))
        compare(service.conversationMessage, "Press Super + Shift + K to start a conversation.")
        verify(service.acceptConversationChunk(JSON.stringify({version: 2, session: "inactive-session", turns: [
            {speaker: "you", text: "Existing turn.", state: "complete", source: "spoken"}
        ]}) + "\n"))
        compare(service.conversationMessage, "")
        compare(service.turns.length, 1)
        service.watcherExited()
        compare(service.state, "unavailable")
        compare(service.statusSentence, "Status unavailable. Microphone use unknown.")
    }

    function test_conversation_rejects_corrupt_and_stale_input() {
        const service = createTemporaryObject(serviceComponent, this)
        verify(service !== null)
        const unavailable = "Conversation unavailable. Reopen the panel."
        const tooLarge = "Conversation is too large to display. Restart Kestrel to begin a new conversation."
        compare(service.acceptConversationChunk(JSON.stringify({version: 1, session: "old-session", turns: [
            {speaker: "you", text: "Unlabelled old input", state: "complete"}
        ]}) + "\n"), false, "version 1 must not guess spoken provenance")
        compare(service.conversationAvailable, false)
        compare(service.conversationMessage, unavailable)
        const snapshot = {version: 2, session: "literal-session", turns: [
            {speaker: "you", text: "<b>Literal owner text</b>", state: "complete", source: "spoken"},
            {speaker: "you", text: "<i>Literal typed text</i>", state: "complete", source: "typed"},
            {speaker: "kestrel", text: "Delivered prefix.", state: "interrupted"}
        ]}
        function send(record) { return service.acceptConversationChunk(JSON.stringify(record) + "\n") }
        function seed() {
            verify(send(snapshot))
            compare(service.conversationAvailable, true)
            compare(service.conversationSession, "literal-session")
            compare(service.turns.length, 3)
            compare(service.turns[0].text, "<b>Literal owner text</b>")
            compare(service.turns[0].source, "spoken")
            compare(service.turns[1].text, "<i>Literal typed text</i>")
            compare(service.turns[1].source, "typed")
        }
        compare(service.turns.length, 0)
        compare(service.conversationMessage, unavailable)
        compare(service.conversationSession, "")
        const encoded = JSON.stringify(snapshot) + "\n"
        verify(service.acceptConversationChunk(encoded.slice(0, 17)))
        compare(service.turns.length, 0)
        verify(service.acceptConversationChunk(encoded.slice(17)))
        compare(service.turns.length, 3)
        compare(service.conversationSession, "literal-session")
        verify(send({alive: "literal-session"}))
        const expiry = findChild(service, "conversationExpiry")
        verify(expiry !== null)
        compare(expiry.interval, 3000)
        verify(expiry.running)
        const invalid = [
            "null\n", "[]\n", "{\n", '{"alive":"other-session"}\n',
            '{"version":2,"session":"other-session","turns":[]}\n',
            '{"version":2,"session":"literal-session","turns":[],"extra":true}\n',
            '{"version":1,"session":"literal-session","turns":[]}\n',
            '{"version":2,"session":"","turns":[]}\n',
            '{"version":2,"session":"literal-session","turns":null}\n',
            '{"unavailable":"invented state"}\n',
            '{"unavailable":"' + unavailable + '","alive":"literal-session"}\n',
            "x".repeat(1048577)
        ]
        for (const field of ["speaker", "text", "state", "source", "extra"]) {
            const copy = JSON.parse(JSON.stringify(snapshot))
            copy.turns[0][field] = field === "text" ? 3 : "unknown"
            invalid.push(JSON.stringify(copy) + "\n")
        }
        const missing = JSON.parse(JSON.stringify(snapshot))
        delete missing.turns[0].source
        invalid.push(JSON.stringify(missing) + "\n")
        for (const source of [null, true, "kestrel", ""]) {
            const copy = JSON.parse(JSON.stringify(snapshot))
            copy.turns[0].source = source
            invalid.push(JSON.stringify(copy) + "\n")
        }
        for (const source of ["spoken", "typed"]) {
            const copy = JSON.parse(JSON.stringify(snapshot))
            copy.turns[2].source = source
            invalid.push(JSON.stringify(copy) + "\n")
        }
        for (const chunk of invalid) {
            seed()
            compare(service.acceptConversationChunk(chunk), false)
            compare(service.turns.length, 0)
            compare(service.conversationAvailable, false)
            compare(service.conversationSession, "")
            compare(service.conversationMessage, unavailable)
            compare(expiry.running, false)
        }
        seed()
        service.conversationExited()
        compare(service.conversationSession, "")
        compare(service.turns.length, 0)
        compare(service.conversationMessage, unavailable)
        seed()
        expiry.triggered()
        compare(service.conversationSession, "")
        compare(service.turns.length, 0)
        compare(service.conversationAvailable, false)
        seed()
        verify(send({unavailable: tooLarge}))
        verify(send({unavailable: tooLarge}))
        compare(service.turns.length, 0)
        compare(service.conversationMessage, tooLarge)
        compare(service.conversationSession, "")
        compare(expiry.running, false)
        verify(send({version: 2, session: "new-service", turns: []}))
        compare(service.conversationAvailable, true)
        compare(service.turns.length, 0)
        compare(service.conversationMessage, "Say something. Kestrel replies after you.")
        compare(service.conversationSession, "new-service")
        service.acceptStatusChunk("L")
        service.setPlacementFailure(true)
        compare(service.placementAdvisory, "Panel position could not be confirmed. Try closing and reopening it.")
        compare(service.state, "listening")
        service.setPlacementFailure(true, "configuration")
        compare(service.placementAdvisory, "Hyprland has configuration errors. Run hyprctl configerrors, fix the errors, then reopen the panel.")
        compare(service.state, "listening")
        service.setPlacementFailure(true, "private transcript canary")
        service.setPlacementFailure(false, "private transcript canary")
        service.setPlacementFailure("true", "position")
        service.setPlacementFailure(0, "configuration")
        compare(service.placementAdvisory, "Hyprland has configuration errors. Run hyprctl configerrors, fix the errors, then reopen the panel.")
        compare(service.state, "listening")
        service.setPlacementFailure(false)
        compare(service.placementAdvisory, "")
        compare(service.state, "listening")
    }

    function test_motion_requires_successful_fresh_true() {
        const service = createTemporaryObject(serviceComponent, this)
        verify(service !== null)
        compare(service.motionEnabled, false)
        const observed = '{"option": "animations:enabled", "bool": true, "set": true }'
        const invalid = [
            "true", "null", "[]", "{", '{}',
            '{"bool":true}', '{"option":"other","bool":true}',
            '{"option":"animations:enabled"}',
            '{"option":"animations:enabled","bool":"true"}',
            '{"option":"animations:enabled","bool":1}',
            '{"option":"animations:enabled","bool":false}',
            observed + " ".repeat(4097)
        ]
        for (const raw of invalid) {
            service.acceptMotionResult(observed, true)
            compare(service.motionEnabled, true)
            service.acceptMotionResult(raw, true)
            compare(service.motionEnabled, false, "invalid preference must disable motion")
        }
        service.acceptMotionResult(observed, true)
        service.acceptMotionResult(observed, false)
        compare(service.motionEnabled, false)
        service.acceptMotionResult('{"option":"animations:enabled","bool":true,"set":false}', true)
        compare(service.motionEnabled, true, "set is metadata rather than the preference")
        const expiry = findChild(service, "motionExpiry")
        verify(expiry !== null)
        compare(expiry.interval, 10000)
        verify(expiry.running)
        expiry.triggered()
        compare(service.motionEnabled, false)
    }
}
