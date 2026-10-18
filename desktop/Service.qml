import QtQuick

Item {
    id: root
    visible: false
    property var shell: null
    // The native service contract deliberately exposes readonly state on a nonvisual Item.
    // qmllint disable property-override
    readonly property string state: statusValue.value
    // qmllint enable property-override
    readonly property bool motionEnabled: motionValue.enabled

    readonly property string statusSentence: ({
        "not-running": "Not running. Microphone released by Kestrel.",
        "starting": "Starting. Microphone may be in use.",
        "unavailable": "Status unavailable. Microphone use unknown.",
        "idle": "Idle. Microphone in use.",
        "listening": "Listening. Microphone in use.",
        "thinking": "Thinking. Microphone in use.",
        "speaking": "Speaking. Microphone in use.",
        "trouble": "Brain trouble. Microphone in use."
    })[state]
    readonly property var turns: conversationValue.turns
    readonly property bool conversationAvailable: conversationValue.available
    readonly property string conversationMessage: conversationValue.message
    readonly property string placementAdvisory: placementValue.advisory

    QtObject {
        id: conversationValue
        property var turns: []
        property bool available: false
        property string message: "Conversation unavailable. Reopen the panel."
        property string session: ""
        property string pending: ""
    }
    QtObject { id: placementValue; property string advisory: "" }

    function setPlacementFailure(failed, reason) {
        if (typeof failed !== "boolean"
                || (reason !== undefined && reason !== "position" && reason !== "configuration")) return
        if (!failed) {
            placementValue.advisory = ""
            return
        }
        placementValue.advisory = reason === "configuration"
            ? "Hyprland has configuration errors. Run hyprctl configerrors, fix the errors, then reopen the panel."
            : "Panel position could not be confirmed. Try closing and reopening it."
    }

    function conversationExited() {
        conversationExpiry.stop()
        conversationValue.turns = []
        conversationValue.available = false
        conversationValue.message = "Conversation unavailable. Reopen the panel."
        conversationValue.session = ""
        conversationValue.pending = ""
    }

    function acceptConversationChunk(chunk) {
        if (typeof chunk !== "string" || chunk.length > 1048576
                || chunk.length > 1048576 - conversationValue.pending.length) {
            conversationExited()
            return false
        }
        conversationValue.pending += chunk
        let end
        while ((end = conversationValue.pending.indexOf("\n")) !== -1) {
            const line = conversationValue.pending.slice(0, end)
            conversationValue.pending = conversationValue.pending.slice(end + 1)
            let record
            try { record = JSON.parse(line) } catch (error) {
                conversationExited()
                return false
            }
            if (!acceptConversationRecord(record)) {
                conversationExited()
                return false
            }
        }
        return true
    }

    function acceptConversationRecord(record) {
        if (record === null || typeof record !== "object" || Array.isArray(record)) return false
        const keys = Object.keys(record).sort().join(",")
        if (keys === "unavailable" && (record.unavailable === "Conversation unavailable. Reopen the panel."
                || record.unavailable === "Conversation is too large to display. Restart Kestrel to begin a new conversation.")) {
            conversationExpiry.stop()
            conversationValue.turns = []
            conversationValue.available = false
            conversationValue.message = record.unavailable
            conversationValue.session = ""
            return true
        }
        if (keys === "alive") {
            if (!conversationValue.available || record.alive !== conversationValue.session) return false
            conversationExpiry.restart()
            return true
        }
        if (keys !== "session,turns,version" || record.version !== 1
                || typeof record.session !== "string" || !record.session.length || record.session.length > 256
                || (conversationValue.session !== "" && record.session !== conversationValue.session)
                || !Array.isArray(record.turns)) return false
        for (const turn of record.turns) {
            if (turn === null || typeof turn !== "object" || Array.isArray(turn)
                    || Object.keys(turn).sort().join(",") !== "speaker,state,text"
                    || (turn.speaker !== "you" && turn.speaker !== "kestrel")
                    || typeof turn.text !== "string"
                    || ["complete", "thinking", "speaking", "interrupted", "failed"].indexOf(turn.state) === -1) return false
        }
        conversationValue.session = record.session
        conversationValue.turns = record.turns
        conversationValue.available = true
        conversationValue.message = record.turns.length ? "" : "Say something. Kestrel replies after you."
        conversationExpiry.restart()
        return true
    }

    Timer {
        id: conversationExpiry
        objectName: "conversationExpiry"
        interval: 3000
        onTriggered: root.conversationExited()
    }

    QtObject { id: statusValue; property string value: "unavailable" }
    QtObject { id: motionValue; property bool enabled: false }

    function acceptStatusChunk(chunk) {
        if (typeof chunk !== "string" || chunk.length < 1 || chunk.length > 32
                || /[^AILTSBNU]/.test(chunk)) {
            expireStatus()
            return false
        }
        const states = { A: "starting", I: "idle", L: "listening", T: "thinking",
            S: "speaking", B: "trouble", N: "not-running", U: "unavailable" }
        statusValue.value = states[chunk.charAt(chunk.length - 1)]
        statusExpiry.restart()
        return true
    }

    function watcherExited() { expireStatus() }

    function expireStatus() {
        statusExpiry.stop()
        statusValue.value = "unavailable"
    }

    function acceptMotionResult(raw, success) {
        expireMotion()
        if (!success || typeof raw !== "string" || raw.length > 4096) return
        let result
        try { result = JSON.parse(raw) } catch (error) { return }
        if (result === null || typeof result !== "object" || Array.isArray(result)
                || result.option !== "animations:enabled" || typeof result.bool !== "boolean") return
        motionValue.enabled = result.bool
        motionExpiry.restart()
    }

    function expireMotion() {
        motionExpiry.stop()
        motionValue.enabled = false
    }

    Timer {
        id: statusExpiry
        objectName: "statusExpiry"
        interval: 3000
        onTriggered: root.expireStatus()
    }
    Timer {
        id: motionExpiry
        objectName: "motionExpiry"
        interval: 10000
        onTriggered: root.expireMotion()
    }
    Loader {
        active: root.shell !== null
        source: "NativeInputs.qml"
        onLoaded: {
            item.owner = root
            // Loader's QObject type cannot describe the dynamically loaded native I/O entry point.
            // qmllint disable missing-property
            item.start()
            // qmllint enable missing-property
        }
    }
}
