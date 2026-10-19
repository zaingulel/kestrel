import QtQuick
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
            compare(mark.visible, kind !== "not-running")
            compare(mark.x, [5, 11, 17][i])
            compare(mark.width, 3)
            compare(mark.height, heights[i])
            compare(mark.y, 21 - heights[i] - offsets[i])
            compare(mark.border.width, kind === "starting" ? 1 : 0)
            compare(mark.color, kind === "starting" ? Qt.rgba(0, 0, 0, 0)
                : kind === "trouble" ? Qt.color("orange") : Qt.color("white"))
            if (kind === "starting") compare(mark.border.color, Qt.color("white"))
        }
        const stem = findChild(marks, "troubleStem")
        compare(stem.visible, kind === "trouble")
        compare(stem.x, 17)
        compare(stem.y, 9)
        compare(stem.width, 3)
        compare(stem.height, 7)
    }

    function test_all_state_shapes() {
        const marks = createTemporaryObject(marksComponent, this)
        verify(marks !== null)
        checkShape(marks, "not-running", [3, 3, 3], [0, 0, 0], 0.6)
        checkShape(marks, "starting", [3, 3, 3], [0, 0, 0], 1)
        checkShape(marks, "unavailable", [3, 3, 3], [0, 3, 6], 1)
        checkShape(marks, "idle", [3, 3, 3], [0, 0, 0], 0.6)
        checkShape(marks, "listening", [12, 12, 12], [0, 0, 0], 1)
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
        for (const kind of ["not-running", "starting", "unavailable", "idle", "listening", "thinking", "speaking", "trouble"]) {
            marks.kind = kind
            marks.motionEnabled = true
            marks.motionEnabled = false
            compare(findChild(marks, "thinkingStep").running, false)
            for (let i = 0; i < 3; i++) compare(animationPart(marks, "speakingLoop", i).running, false)
        }
        checkShape(marks, "thinking", [3, 3, 3], [0, 5, 0], 1)
        checkShape(marks, "speaking", [6, 12, 8], [0, 0, 0], 1)
    }
}
