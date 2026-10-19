pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Shapes

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
    Item {
        id: listening
        objectName: "listeningMark"
        property real phase: 0
        readonly property bool active: root.kind === "listening" && root.motionEnabled
        visible: root.kind === "listening"
        onActiveChanged: if (!active) phase = 0

        NumberAnimation {
            objectName: "listeningLoop"
            target: listening
            property: "phase"
            from: 0
            to: 1
            duration: 1600
            easing.type: Easing.Linear
            loops: Animation.Infinite
            running: listening.active
        }
        Repeater {
            model: 2
            delegate: Shape {
                id: ring
                required property int index
                readonly property real ringPhase: (listening.phase + index * 0.5) % 1
                readonly property real diameter: !root.motionEnabled ? 9
                    : ringPhase <= 0.7 ? 15 - 10 * Math.pow(ringPhase / 0.7, 2)
                    : 5 - 2 * Math.pow((ringPhase - 0.7) / 0.3, 2)
                objectName: "listeningRing" + index
                preferredRendererType: Shape.CurveRenderer
                x: 5; y: 7.5; width: 15; height: 15
                visible: root.motionEnabled || index === 0
                opacity: !root.motionEnabled ? 0.6
                    : ringPhase <= 0.7 ? Math.pow(ringPhase / 0.7, 2)
                    : 1 - (ringPhase - 0.7) / 0.3
                ShapePath {
                    objectName: "listeningPath" + ring.index
                    strokeColor: root.ink
                    strokeWidth: 1.5
                    fillColor: "transparent"
                    PathAngleArc {
                        objectName: "listeningArc" + ring.index
                        centerX: 7.5
                        centerY: 7.5
                        radiusX: (ring.diameter - 1.5) / 2
                        radiusY: radiusX
                        startAngle: 0
                        sweepAngle: 360
                    }
                }
            }
        }
        Rectangle {
            readonly property real pulseTime: (1600 * listening.phase) % 800
            objectName: "listeningDot"
            x: 11; y: 13.5; width: 3; height: 3
            radius: 1.5
            color: root.ink
            scale: root.motionEnabled && pulseTime < 120
                ? 1 + 0.1 * Math.sin(Math.PI * pulseTime / 120) : 1
        }
    }
    Repeater {
        model: 3
        delegate: Rectangle {
            id: mark
            required property int index
            property real animatedHeight: [6, 12, 8][index]
            objectName: "mark" + index
            visible: root.kind !== "not-running" && root.kind !== "listening"
            x: 5 + index * 6
            y: 21 - height - (root.kind === "unavailable" ? index * 3
                : root.kind === "thinking" && root.thinkingIndex === index ? 5 : 0)
            width: 3
            height: root.kind === "speaking" ? (root.motionEnabled ? animatedHeight : [6, 12, 8][index]) : 3
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
