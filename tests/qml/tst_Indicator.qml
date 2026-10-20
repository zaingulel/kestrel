import QtQuick
import QtQuick.Shapes
import QtTest
import "../../desktop" as Desktop

TestCase {
    name: "Indicator"
    visible: true
    width: 100
    height: 100
    when: windowShown

    Component {
        id: marksComponent
        Desktop.Marks { ink: "white"; troubleInk: "orange" }
    }

    function animationPart(marks, name, index) {
        return findChild(findChild(marks, "mark" + index), name + index)
    }

    function checkShape(marks, kind, heights, offsets, opacity) {
        marks.kind = kind
        compare(marks.implicitWidth, 25)
        compare(marks.implicitHeight, 30)
        compare(marks.opacity, opacity)
        const resting = findChild(marks, "restingBar")
        compare(resting.visible, kind === "not-running")
        compare(resting.x, 5)
        compare(resting.y, 19)
        compare(resting.width, 15)
        compare(resting.height, 2)
        for (let i = 0; i < 3; i++) {
            const mark = findChild(marks, "mark" + i)
            verify(mark !== null)
            compare(mark.visible, kind !== "not-running" && kind !== "listening")
            compare(mark.x, [5, 11, 17][i])
            compare(mark.width, 3)
            compare(mark.height, heights[i])
            compare(mark.y, 21 - heights[i] - offsets[i])
            compare(mark.border.width, (kind === "starting" || kind === "inactive") ? 1 : 0)
            compare(mark.color, (kind === "starting" || kind === "inactive") ? Qt.rgba(0, 0, 0, 0)
                : kind === "trouble" ? Qt.color("orange") : Qt.color("white"))
            if (kind === "starting" || kind === "inactive") compare(mark.border.color, Qt.color("white"))
        }
        const stem = findChild(marks, "troubleStem")
        compare(stem.visible, kind === "trouble")
        compare(stem.x, 17)
        compare(stem.y, 9)
        compare(stem.width, 3)
        compare(stem.height, 7)
    }

    function checkRing(marks, index, radius, opacity) {
        const ring = findChild(marks, "listeningRing" + index)
        verify(ring !== null)
        compare(ring.x, 5)
        compare(ring.y, 7.5)
        compare(ring.width, 15)
        compare(ring.preferredRendererType, Shape.CurveRenderer)
        compare(ring.height, 15)
        fuzzyCompare(ring.opacity, opacity, 0.00001)
        const path = findChild(ring, "listeningPath" + index)
        verify(path !== null)
        compare(path.strokeWidth, 1.5)
        compare(path.strokeColor, Qt.color("white"))
        compare(path.fillColor, Qt.rgba(0, 0, 0, 0))
        const arc = findChild(path, "listeningArc" + index)
        verify(arc !== null)
        compare(arc.centerX, 7.5)
        compare(arc.centerY, 7.5)
        fuzzyCompare(arc.radiusX, radius, 0.00001)
        fuzzyCompare(arc.radiusY, radius, 0.00001)
        compare(arc.sweepAngle, 360)
    }

    function checkStillInflow(marks) {
        const listening = findChild(marks, "listeningMark")
        verify(listening !== null)
        compare(listening.visible, true)
        compare(listening.phase, 0)
        compare(findChild(listening, "listeningLoop").running, false)
        compare(findChild(listening, "listeningRing0").visible, true)
        compare(findChild(listening, "listeningRing1").visible, false)
        checkRing(marks, 0, 3.75, 0.6)
        const dot = findChild(listening, "listeningDot")
        verify(dot !== null)
        compare(dot.visible, true)
        compare(dot.x, 11)
        compare(dot.y, 13.5)
        compare(dot.width, 3)
        compare(dot.height, 3)
        compare(dot.radius, 1.5)
        compare(dot.color, Qt.color("white"))
        compare(dot.opacity, 1)
        compare(dot.scale, 1)
        compare(dot.transformOrigin, Item.Center)
        compare(marks.Accessible.ignored, true)
    }

    function test_feed_marks_geometry_and_motion() {
        const marks = createTemporaryObject(marksComponent, this, {feed: true, kind: "thinking"})
        verify(marks !== null)
        compare(marks.implicitWidth, 40)
        compare(marks.implicitHeight, 26)
        compare(marks.opacity, 1)
        compare(marks.Accessible.ignored, true)
        compare(marks.thinkingIndex, 1)
        compare(findChild(marks, "restingBar").visible, false)
        compare(findChild(marks, "listeningMark").visible, false)
        compare(findChild(marks, "troubleStem").visible, false)
        const stepper = findChild(marks, "thinkingStep")
        compare(stepper.interval, 280)
        compare(stepper.running, false)
        for (let i = 0; i < 3; i++) {
            const mark = findChild(marks, "mark" + i)
            verify(mark !== null)
            compare(mark.visible, true)
            compare(mark.x, [10, 18, 26][i])
            compare(mark.y, [17, 11, 17][i])
            compare(mark.width, 4)
            compare(mark.height, 4)
            compare(mark.animatedHeight, [8, 16, 11][i])
            compare(mark.color, Qt.color("white"))
            compare(mark.border.width, 0)
            compare(animationPart(marks, "speakingLoop", i).running, false)
            compare(animationPart(marks, "speakingLoop", i).loops, -1)
            compare(animationPart(marks, "speakingDown", i).to, 5)
            compare(animationPart(marks, "speakingUp", i).to, 16)
            compare(animationPart(marks, "speakingDown", i).duration, [210, 260, 305][i])
            compare(animationPart(marks, "speakingUp", i).duration, [210, 260, 305][i])
            compare(animationPart(marks, "speakingDown", i).easing.type, Easing.InOutSine)
            compare(animationPart(marks, "speakingUp", i).easing.type, Easing.InOutSine)
        }

        marks.motionEnabled = true
        compare(stepper.running, true)
        for (const expectedY of [[17, 17, 11], [11, 17, 17], [17, 11, 17]]) {
            stepper.triggered()
            for (let i = 0; i < 3; i++) compare(findChild(marks, "mark" + i).y, expectedY[i])
        }
        stepper.triggered()
        compare(marks.thinkingIndex, 2)
        marks.motionEnabled = false
        compare(marks.kind, "thinking")
        compare(marks.thinkingIndex, 1)
        compare(stepper.running, false)
        for (let i = 0; i < 3; i++) {
            compare(findChild(marks, "mark" + i).y, [17, 11, 17][i])
            compare(animationPart(marks, "speakingLoop", i).running, false)
        }

        marks.kind = "speaking"
        compare(stepper.running, false)
        for (let i = 0; i < 3; i++) {
            const mark = findChild(marks, "mark" + i)
            compare(mark.x, [10, 18, 26][i])
            compare(mark.width, 4)
            compare(mark.height, [8, 16, 11][i])
            compare(mark.y, [13, 5, 10][i])
            compare(animationPart(marks, "speakingLoop", i).running, false)
        }
        marks.motionEnabled = true
        compare(marks.kind, "speaking")
        compare(stepper.running, false)
        for (let i = 0; i < 3; i++) compare(animationPart(marks, "speakingLoop", i).running, true)
        marks.motionEnabled = false
        compare(marks.kind, "speaking")
        for (let i = 0; i < 3; i++) {
            compare(animationPart(marks, "speakingLoop", i).running, false)
            compare(findChild(marks, "mark" + i).height, [8, 16, 11][i])
            compare(findChild(marks, "mark" + i).y, [13, 5, 10][i])
        }
        marks.motionEnabled = true
        for (let i = 0; i < 3; i++) compare(animationPart(marks, "speakingLoop", i).running, true)
        marks.kind = "thinking"
        compare(marks.thinkingIndex, 1)
        compare(stepper.running, true)
        for (let i = 0; i < 3; i++) {
            compare(animationPart(marks, "speakingLoop", i).running, false)
            compare(findChild(marks, "mark" + i).height, 4)
            compare(findChild(marks, "mark" + i).y, [17, 11, 17][i])
        }
        marks.motionEnabled = false
        compare(marks.kind, "thinking")
        compare(stepper.running, false)
    }

    function test_all_state_shapes() {
        const marks = createTemporaryObject(marksComponent, this)
        verify(marks !== null)
        checkShape(marks, "not-running", [3, 3, 3], [0, 0, 0], 0.6)
        checkShape(marks, "inactive", [3, 3, 3], [0, 0, 0], 0.6)
        checkShape(marks, "starting", [3, 3, 3], [0, 0, 0], 1)
        checkShape(marks, "unavailable", [3, 3, 3], [0, 3, 6], 1)
        checkShape(marks, "idle", [3, 3, 3], [0, 0, 0], 0.6)
        checkShape(marks, "listening", [3, 3, 3], [0, 0, 0], 1)
        checkStillInflow(marks)
        checkShape(marks, "thinking", [3, 3, 3], [0, 5, 0], 1)
        checkShape(marks, "speaking", [6, 12, 8], [0, 0, 0], 1)
        checkShape(marks, "trouble", [3, 3, 3], [0, 0, 0], 1)

        marks.motionEnabled = true
        marks.kind = "thinking"
        const stepper = findChild(marks, "thinkingStep")
        verify(stepper.running)
        compare(stepper.interval, 280)
        stepper.triggered()
        compare(findChild(marks, "mark2").y, 13)
        marks.kind = "speaking"
        compare(stepper.running, false)
        for (let i = 0; i < 3; i++) {
            verify(animationPart(marks, "speakingLoop", i).running)
            compare(animationPart(marks, "speakingDown", i).duration, [210, 260, 305][i])
            compare(animationPart(marks, "speakingUp", i).duration, [210, 260, 305][i])
            compare(animationPart(marks, "speakingDown", i).to, 4)
            compare(animationPart(marks, "speakingUp", i).to, 12)
            compare(animationPart(marks, "speakingDown", i).easing.type, Easing.InOutSine)
            compare(animationPart(marks, "speakingUp", i).easing.type, Easing.InOutSine)
        }
    }

    function test_reduced_motion_still_shapes() {
        const marks = createTemporaryObject(marksComponent, this)
        verify(marks !== null)
        for (const kind of ["not-running", "inactive", "starting", "unavailable", "idle", "listening", "thinking", "speaking", "trouble"]) {
            marks.kind = kind
            marks.motionEnabled = true
            if (kind === "inactive") {
                checkShape(marks, "inactive", [3, 3, 3], [0, 0, 0], 0.6)
                compare(findChild(marks, "thinkingStep").running, false)
                compare(findChild(marks, "listeningLoop").running, false)
                for (let i = 0; i < 3; i++) compare(animationPart(marks, "speakingLoop", i).running, false)
            }
            marks.motionEnabled = false
            if (kind === "inactive") checkShape(marks, "inactive", [3, 3, 3], [0, 0, 0], 0.6)
            const listening = findChild(marks, "listeningMark")
            verify(listening !== null)
            compare(listening.visible, kind === "listening")
            compare(findChild(listening, "listeningLoop").running, false)
            if (kind === "listening") checkStillInflow(marks)
            compare(findChild(marks, "thinkingStep").running, false)
            for (let i = 0; i < 3; i++) compare(animationPart(marks, "speakingLoop", i).running, false)
        }
        checkShape(marks, "thinking", [3, 3, 3], [0, 5, 0], 1)
        checkShape(marks, "speaking", [6, 12, 8], [0, 0, 0], 1)
    }

    function test_listening_inflow_motion() {
        const marks = createTemporaryObject(marksComponent, this)
        verify(marks !== null)
        const listening = findChild(marks, "listeningMark")
        verify(listening !== null)
        const loop = findChild(listening, "listeningLoop")
        verify(loop !== null)
        compare(loop.from, 0)
        compare(loop.to, 1)
        compare(loop.duration, 1600)
        compare(loop.easing.type, Easing.Linear)
        // Qt normalizes the Animation.Infinite loop count to -1 on readback.
        compare(loop.loops, -1)
        compare(listening.visible, false)
        compare(loop.running, false)
        marks.motionEnabled = true
        marks.kind = "listening"
        compare(listening.visible, true)
        compare(loop.running, true)
        compare(listening.phase, 0)
        tryVerify(function() { return listening.phase > 0 }, 5000)
        loop.pause()
        verify(loop.paused)
        listening.phase = 0
        compare(findChild(listening, "listeningRing0").visible, true)
        compare(findChild(listening, "listeningRing1").visible, true)
        checkRing(marks, 0, 6.75, 0)
        checkRing(marks, 1, 4.19897959185, 0.5102040816)
        listening.phase = 0.35
        checkRing(marks, 0, 5.5, 0.25)
        listening.phase = 0.7
        checkRing(marks, 0, 1.75, 1)
        listening.phase = 0.85
        checkRing(marks, 0, 1.5, 0.5)
        const dot = findChild(listening, "listeningDot")
        listening.phase = 0.0375
        fuzzyCompare(dot.scale, 1.1, 0.00001)
        listening.phase = 0.075
        compare(dot.scale, 1)
        marks.kind = "idle"
        compare(listening.visible, false)
        compare(loop.running, false)
        compare(listening.phase, 0)
        marks.kind = "listening"
        compare(loop.running, true)
        compare(loop.paused, false)
        compare(listening.phase, 0)
        loop.pause()
        listening.phase = 0.35
        marks.motionEnabled = false
        checkStillInflow(marks)
        marks.motionEnabled = true
        compare(loop.running, true)
        compare(loop.paused, false)
        compare(listening.phase, 0)
        marks.kind = "speaking"
        compare(loop.running, false)
        compare(listening.visible, false)
        compare(listening.phase, 0)
    }
}
