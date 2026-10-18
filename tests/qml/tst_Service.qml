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

    function test_conversation_rejects_corrupt_and_stale_input() {
        const service = createTemporaryObject(serviceComponent, this)
        verify(service !== null)
        const unavailable = "Conversation unavailable. Reopen the panel."
        const tooLarge = "Conversation is too large to display. Restart Kestrel to begin a new conversation."
        const snapshot = {version: 1, session: "literal-session", turns: [
            {speaker: "you", text: "<b>Literal owner text</b>", state: "complete"},
            {speaker: "kestrel", text: "Delivered prefix.", state: "interrupted"}
        ]}
        function send(record) { return service.acceptConversationChunk(JSON.stringify(record) + "\n") }
        function seed() {
            verify(send(snapshot))
            compare(service.conversationAvailable, true)
            compare(service.turns.length, 2)
            compare(service.turns[0].text, "<b>Literal owner text</b>")
        }
        compare(service.turns.length, 0)
        compare(service.conversationMessage, unavailable)
        const encoded = JSON.stringify(snapshot) + "\n"
        verify(service.acceptConversationChunk(encoded.slice(0, 17)))
        compare(service.turns.length, 0)
        verify(service.acceptConversationChunk(encoded.slice(17)))
        compare(service.turns.length, 2)
        verify(send({alive: "literal-session"}))
        const expiry = findChild(service, "conversationExpiry")
        verify(expiry !== null)
        compare(expiry.interval, 3000)
        verify(expiry.running)
        const invalid = [
            "null\n", "[]\n", "{\n", '{"alive":"other-session"}\n',
            '{"version":1,"session":"other-session","turns":[]}\n',
            '{"version":1,"session":"literal-session","turns":[],"extra":true}\n',
            '{"version":2,"session":"literal-session","turns":[]}\n',
            '{"version":1,"session":"","turns":[]}\n',
            '{"version":1,"session":"literal-session","turns":null}\n',
            '{"unavailable":"invented state"}\n',
            '{"unavailable":"' + unavailable + '","alive":"literal-session"}\n',
            "x".repeat(1048577)
        ]
        for (const field of ["speaker", "text", "state", "extra"]) {
            const copy = JSON.parse(JSON.stringify(snapshot))
            copy.turns[0][field] = field === "text" ? 3 : "unknown"
            invalid.push(JSON.stringify(copy) + "\n")
        }
        for (const chunk of invalid) {
            seed()
            compare(service.acceptConversationChunk(chunk), false)
            compare(service.turns.length, 0)
            compare(service.conversationAvailable, false)
            compare(service.conversationMessage, unavailable)
            compare(expiry.running, false)
        }
        seed()
        service.conversationExited()
        compare(service.turns.length, 0)
        compare(service.conversationMessage, unavailable)
        seed()
        expiry.triggered()
        compare(service.turns.length, 0)
        compare(service.conversationAvailable, false)
        seed()
        verify(send({unavailable: tooLarge}))
        verify(send({unavailable: tooLarge}))
        compare(service.turns.length, 0)
        compare(service.conversationMessage, tooLarge)
        compare(expiry.running, false)
        verify(send({version: 1, session: "new-service", turns: []}))
        compare(service.conversationAvailable, true)
        compare(service.turns.length, 0)
        compare(service.conversationMessage, "Say something. Kestrel replies after you.")
        service.acceptStatusChunk("L")
        service.setPlacementFailure(true)
        compare(service.placementAdvisory, "Panel position could not be confirmed. Try closing and reopening it.")
        compare(service.state, "listening")
        service.setPlacementFailure(false)
        compare(service.placementAdvisory, "")
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
