pragma ComponentBehavior: Bound
import QtQuick

Item {
    id: root
    property string kind: "unavailable"
    required property color ink
    required property color troubleInk
    property bool motionEnabled: false
    property int thinkingIndex: 1

    implicitWidth: 25
    implicitHeight: 30
    opacity: kind === "idle" || kind === "not-running" ? 0.6 : 1
    Accessible.ignored: true

    onKindChanged: thinkingIndex = 1
    onMotionEnabledChanged: thinkingIndex = 1

    Rectangle {
        objectName: "restingBar"
        visible: root.kind === "not-running"
        x: 5; y: 19; width: 15; height: 2
        color: root.ink
    }
    Timer {
        id: thinkingStep
        objectName: "thinkingStep"
        interval: 280
        repeat: true
        running: root.kind === "thinking" && root.motionEnabled
        onTriggered: root.thinkingIndex = (root.thinkingIndex + 1) % 3
    }
    Repeater {
        model: 3
        delegate: Rectangle {
            id: mark
            required property int index
            property real animatedHeight: [6, 12, 8][index]
            objectName: "mark" + index
            visible: root.kind !== "not-running"
            x: 5 + index * 6
            y: 21 - height - (root.kind === "unavailable" ? index * 3
                : root.kind === "thinking" && root.thinkingIndex === index ? 5 : 0)
            width: 3
            height: root.kind === "listening" ? 12
                : root.kind === "speaking" ? (root.motionEnabled ? animatedHeight : [6, 12, 8][index]) : 3
            color: root.kind === "starting" ? "transparent" : root.kind === "trouble" ? root.troubleInk : root.ink
            border.width: root.kind === "starting" ? 1 : 0
            border.color: root.ink

            SequentialAnimation on animatedHeight {
                objectName: "speakingLoop" + mark.index
                loops: Animation.Infinite
                running: root.kind === "speaking" && root.motionEnabled
                NumberAnimation {
                    objectName: "speakingDown" + mark.index
                    to: 4
                    duration: [420, 520, 610][mark.index] / 2
                    easing.type: Easing.InOutSine
                }
                NumberAnimation {
                    objectName: "speakingUp" + mark.index
                    to: 12
                    duration: [420, 520, 610][mark.index] / 2
                    easing.type: Easing.InOutSine
                }
            }
        }
    }
    Rectangle {
        objectName: "troubleStem"
        visible: root.kind === "trouble"
        x: 17; y: 9; width: 3; height: 7
        color: root.troubleInk
    }
}
