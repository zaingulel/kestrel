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
