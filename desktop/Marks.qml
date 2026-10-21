pragma ComponentBehavior: Bound
import QtQuick

Item {
    id: root
    property string kind: "unavailable"
    required property color ink
    required property color troubleInk
    property bool motionEnabled: false
    property bool feed: false

    component Glide: NumberAnimation { duration: 180; easing.type: Easing.OutCubic }
    component Phase: FrameAnimation {
        required property int period
        property real phase: 0
        onTriggered: phase = (phase + frameTime * 1000 / period) % 1
    }

    // A kind without an entry, unavailable included, keeps the base (unavailable) form.
    readonly property var form: Object.assign({h: [4, 8, 12], lift: 0, spread: 0, hollow: 0, alarm: 0, opacity: 1, listen: 0, think: 0, speak: 0}, ({
        "not-running": {h: [2, 2, 2], spread: 1, opacity: 0.6},
        "inactive": {h: [6, 6, 6], hollow: 1, opacity: 0.6},
        "starting": {h: [6, 6, 6], hollow: 1},
        "idle": {h: [6, 6, 6], opacity: 0.6},
        "listening": {h: [12, 12, 12]},
        "thinking": {h: [6, 12, 6]},
        "speaking": {h: [12, 6, 12]},
        "trouble": {h: [6, 6, 7], lift: -2.5, alarm: 1}
    })[kind])

    property real h0: form.h[0]
    property real h1: form.h[1]
    property real h2: form.h[2]
    property real lift: form.lift
    property real spread: form.spread
    property real hollow: form.hollow
    property real alarm: form.alarm
    property real fade: form.opacity
    property real listenWeight: motionEnabled && kind === "listening" ? 1 : 0
    property real thinkWeight: motionEnabled && kind === "thinking" ? 1 : 0
    property real speakWeight: motionEnabled && kind === "speaking" ? 1 : 0
    Behavior on h0 { Glide { objectName: "glide" } }
    Behavior on h1 { Glide {} }
    Behavior on h2 { Glide {} }
    Behavior on lift { Glide {} }
    Behavior on spread { Glide {} }
    Behavior on hollow { Glide {} }
    Behavior on alarm { Glide {} }
    Behavior on fade { Glide {} }
    Behavior on listenWeight { Glide {} }
    Behavior on thinkWeight { Glide {} }
    Behavior on speakWeight { Glide {} }

    // With motion off the form shows at once, mid-glide included, while the glide values settle unseen;
    // a synchronous off-and-on flip therefore changes nothing on screen.
    readonly property var shown: motionEnabled ? ({h: [h0, h1, h2], lift: lift, spread: spread, hollow: hollow,
        alarm: alarm, opacity: fade, listen: listenWeight, think: thinkWeight, speak: speakWeight}) : form
    readonly property color barInk: Qt.tint(ink, Qt.rgba(troubleInk.r, troubleInk.g, troubleInk.b, shown.alarm))
    readonly property real unit: feed ? 4 / 3 : 1

    implicitWidth: feed ? 40 : 25
    implicitHeight: feed ? 26 : 30
    opacity: shown.opacity
    Accessible.ignored: true

    Phase { id: listenDriver; objectName: "listenDriver"; period: 1600; running: root.motionEnabled && root.kind === "listening" }
    Phase { id: rippleDriver; objectName: "rippleDriver"; period: 840; running: root.motionEnabled && root.kind === "thinking" }

    Repeater {
        model: 3
        delegate: Rectangle {
            id: bar
            required property int index
            readonly property real rippleOffset: (1 - index) / 3
            objectName: "mark" + index
            x: (root.feed ? 10 : 5) + 6 * index * root.unit
            width: (3 + (index === 2 ? 0 : 3 * root.shown.spread)) * root.unit
            // Each motion term is its difference from phase 0, so a weight or phase of 0 leaves the still form exactly.
            height: (root.shown.h[index]
                + root.shown.listen * 3 * (Math.cos(2 * Math.PI * listenDriver.phase) - 1)
                + root.shown.think * 4 * (Math.cos(2 * Math.PI * (rippleDriver.phase + rippleOffset)) - Math.cos(2 * Math.PI * rippleOffset))
                + root.shown.speak * [4, -3, 4][index] * (Math.cos(2 * Math.PI * speakDriver.phase) - 1)) * root.unit
            y: (root.feed ? 13 : 15) + (index === 2 ? root.shown.lift : 0) * root.unit - height / 2
            color: Qt.rgba(root.barInk.r, root.barInk.g, root.barInk.b, 1 - root.shown.hollow)
            border.width: 1
            border.color: root.barInk
            Phase { id: speakDriver; objectName: "speakDriver" + bar.index; period: [420, 520, 610][bar.index]; running: root.motionEnabled && root.kind === "speaking" }
        }
    }
    Rectangle {
        objectName: "troubleDot"
        x: (root.feed ? 10 : 5) + 12 * root.unit
        y: (root.feed ? 13 : 15) + 3 * root.unit
        width: 3 * root.unit
        height: 3 * root.unit
        color: root.troubleInk
        opacity: root.shown.alarm
        visible: root.shown.alarm !== 0
    }
}
