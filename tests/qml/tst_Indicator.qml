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

    // Still forms at indicator scale, from docs/DESIGN-SYSTEM.md "The three marks".
    readonly property var forms: ({
        "not-running": {h: [2, 2, 2], y: [14, 14, 14], widths: [6, 6, 3], opacity: 0.6},
        "inactive": {h: [6, 6, 6], y: [12, 12, 12], hollow: true, opacity: 0.6},
        "starting": {h: [6, 6, 6], y: [12, 12, 12], hollow: true},
        "unavailable": {h: [4, 8, 12], y: [13, 11, 9]},
        "idle": {h: [6, 6, 6], y: [12, 12, 12], opacity: 0.6},
        "listening": {h: [12, 12, 12], y: [9, 9, 9]},
        "thinking": {h: [6, 12, 6], y: [12, 9, 12]},
        "speaking": {h: [12, 6, 12], y: [9, 12, 9]},
        "trouble": {h: [6, 6, 7], y: [12, 12, 9], trouble: true}
    })

    function bar(marks, i) {
        const found = findChild(marks, "mark" + i)
        verify(found !== null, "bar " + i + " exists")
        return found
    }

    function driver(parent, name) {
        const found = findChild(parent, name)
        verify(found !== null, name + " exists")
        return found
    }

    function speakDriver(marks, i) {
        return driver(bar(marks, i), "speakDriver" + i)
    }

    function drivers(marks) {
        return [driver(marks, "listenDriver"), driver(marks, "rippleDriver"),
            speakDriver(marks, 0), speakDriver(marks, 1), speakDriver(marks, 2)]
    }

    function hold(phaseDriver, phase) {
        phaseDriver.pause()
        phaseDriver.phase = phase
    }

    function heights(marks) {
        return [0, 1, 2].map(function(i) { return bar(marks, i).height })
    }

    function checkForm(marks, name, label) {
        const form = forms[name]
        const what = (label === undefined ? name : label) + ": "
        compare(marks.implicitWidth, 25)
        compare(marks.implicitHeight, 30)
        compare(marks.opacity, form.opacity === undefined ? 1 : form.opacity, what + "opacity")
        const barInk = form.trouble ? "orange" : "white"
        for (let i = 0; i < 3; i++) {
            const mark = bar(marks, i)
            compare(mark.visible, true, what + "bar " + i + " visible")
            compare(mark.x, [5, 11, 17][i], what + "bar " + i + " x")
            compare(mark.width, form.widths === undefined ? 3 : form.widths[i], what + "bar " + i + " width")
            compare(mark.height, form.h[i], what + "bar " + i + " height")
            compare(mark.y, form.y[i], what + "bar " + i + " y")
            compare(mark.color.a, form.hollow ? 0 : 1, what + "bar " + i + " fill alpha")
            verify(Qt.colorEqual(mark.border.color, barInk), what + "bar " + i + " border " + mark.border.color)
            if (!form.hollow) verify(Qt.colorEqual(mark.color, barInk), what + "bar " + i + " fill " + mark.color)
        }
        const dot = driver(marks, "troubleDot")
        compare(dot.visible, form.trouble === true, what + "dot visible")
        if (form.trouble) {
            compare(dot.x, 17)
            compare(dot.y, 18)
            compare(dot.width, 3)
            compare(dot.height, 3)
            compare(dot.opacity, 1)
            verify(Qt.colorEqual(dot.color, "orange"))
        }
    }

    function settle(marks, name) {
        for (const [weight, moving] of [["listenWeight", "listening"], ["thinkWeight", "thinking"], ["speakWeight", "speaking"]])
            tryCompare(marks, weight, moving === name ? 1 : 0, 2000, name + " " + weight)
        tryCompare(marks, "opacity", forms[name].opacity === undefined ? 1 : forms[name].opacity, 2000, name + " opacity")
        for (let i = 0; i < 3; i++) {
            tryCompare(bar(marks, i), "height", forms[name].h[i], 2000, name + " bar " + i + " height")
            tryCompare(bar(marks, i), "y", forms[name].y[i], 2000, name + " bar " + i + " y")
        }
        checkForm(marks, name)
    }

    function onScreen(marks) {
        return [0, 1, 2].map(function(i) {
            const mark = bar(marks, i)
            const border = mark.border.color
            return [mark.height, mark.y, border.r, border.g, border.b, border.a]
        })
    }

    function test_all_state_shapes() {
        const marks = createTemporaryObject(marksComponent, this)
        verify(marks !== null)
        compare(marks.Accessible.ignored, true)
        checkForm(marks, "unavailable", "default kind")
        for (const kind of Object.keys(forms)) {
            marks.kind = kind
            checkForm(marks, kind)
        }
        for (const kind of ["complete", "interrupted", "failed", "bogus", "constructor", ""]) {
            marks.kind = "idle"
            marks.kind = kind
            checkForm(marks, "unavailable", "kind \"" + kind + "\"")
        }
    }

    function test_feed_marks_geometry_and_motion() {
        const marks = createTemporaryObject(marksComponent, this, {feed: true, kind: "thinking"})
        verify(marks !== null)
        compare(marks.implicitWidth, 40)
        compare(marks.implicitHeight, 26)
        for (const [kind, expectedHeights, expectedY] of [["thinking", [8, 16, 8], [9, 5, 9]],
                ["speaking", [16, 8, 16], [5, 9, 5]], ["listening", [16, 16, 16], [5, 5, 5]]]) {
            marks.kind = kind
            for (let i = 0; i < 3; i++) {
                const mark = bar(marks, i)
                compare(mark.x, [10, 18, 26][i], kind + " bar " + i + " x")
                compare(mark.width, 4, kind + " bar " + i + " width")
                compare(mark.height, expectedHeights[i], kind + " bar " + i + " height")
                compare(mark.y, expectedY[i], kind + " bar " + i + " y")
            }
        }
        const ripple = driver(marks, "rippleDriver")
        compare(ripple.period, 840)
        marks.kind = "thinking"
        marks.motionEnabled = true
        tryCompare(marks, "thinkWeight", 1, 2000)
        hold(ripple, 1 / 3)
        compare(heights(marks), [8, 8, 16], "the crest has moved one bar right")
        hold(ripple, 2 / 3)
        compare(heights(marks), [16, 8, 8], "the crest has wrapped to the first bar")
    }

    function test_reduced_motion_still_shapes() {
        const marks = createTemporaryObject(marksComponent, this)
        verify(marks !== null)
        for (const kind of Object.keys(forms)) {
            marks.kind = kind
            checkForm(marks, kind, "motion off, " + kind)
            for (const phaseDriver of drivers(marks)) compare(phaseDriver.running, false, kind + " " + phaseDriver.objectName)
        }

        marks.kind = "idle"
        marks.motionEnabled = true
        settle(marks, "idle")
        marks.kind = "trouble"
        marks.motionEnabled = false
        checkForm(marks, "trouble", "motion off mid-glide")

        marks.motionEnabled = true
        marks.kind = "speaking"
        tryCompare(marks, "speakWeight", 1, 2000)
        for (let i = 0; i < 3; i++) compare(speakDriver(marks, i).running, true)
        marks.motionEnabled = false
        checkForm(marks, "speaking", "motion off mid-loop")
        for (const phaseDriver of drivers(marks)) compare(phaseDriver.running, false, "mid-loop " + phaseDriver.objectName)

        marks.motionEnabled = true
        marks.kind = "listening"
        tryCompare(marks, "listenWeight", 1, 2000)
        const listen = driver(marks, "listenDriver")
        tryVerify(function() { return listen.phase > 0.15 && listen.phase < 0.85 }, 2000)
        const phase = listen.phase
        const moving = heights(marks)
        // Mirrors Service.acceptMotionResult, which turns motion off and on again in one call on every poll.
        marks.motionEnabled = false; marks.motionEnabled = true
        compare(listen.phase, phase)
        compare(heights(marks), moving)
        compare(listen.running, true)

        marks.motionEnabled = false
        tryCompare(marks, "listenWeight", 0, 2000)
        marks.motionEnabled = true
        compare(heights(marks), [12, 12, 12], "motion resumes from the still form")
        tryCompare(marks, "listenWeight", 1, 2000)
    }

    function test_listening_bars_move_together() {
        const marks = createTemporaryObject(marksComponent, this, {kind: "listening"})
        verify(marks !== null)
        const listen = driver(marks, "listenDriver")
        compare(listen.period, 1600)
        marks.motionEnabled = true
        tryCompare(marks, "listenWeight", 1, 2000)
        for (const [phase, expected] of [[0, 12], [0.25, 9], [0.5, 6], [0.75, 9]]) {
            hold(listen, phase)
            for (let i = 0; i < 3; i++) {
                const mark = bar(marks, i)
                compare(mark.height, expected, "phase " + phase + " bar " + i + " height")
                compare(mark.y + mark.height / 2, 15, "phase " + phase + " bar " + i + " centre")
            }
        }

        hold(listen, 0.1)
        let elapsed = 0
        const addFrame = function() { elapsed += listen.frameTime }
        listen.triggered.connect(addFrame)
        listen.resume()
        tryVerify(function() { return elapsed > 0.2 }, 2000)
        listen.pause()
        listen.triggered.disconnect(addFrame)
        fuzzyCompare(listen.phase, (0.1 + elapsed * 1000 / 1600) % 1, 0.0001)

        listen.resume()
        marks.kind = "idle"
        const held = listen.phase
        wait(100)
        compare(listen.phase, held, "leaving listening holds its phase")

        for (let i = 0; i < 3; i++) compare(speakDriver(marks, i).period, [420, 520, 610][i])
        marks.kind = "speaking"
        tryCompare(marks, "speakWeight", 1, 2000)
        for (let i = 0; i < 3; i++) hold(speakDriver(marks, i), 0.25)
        for (let i = 0; i < 3; i++) tryCompare(bar(marks, i), "height", [8, 9, 8][i], 2000, "speaking bar " + i)
    }

    function test_state_changes_glide() {
        const marks = createTemporaryObject(marksComponent, this, {kind: "idle", motionEnabled: true})
        verify(marks !== null)
        const holdMoving = {
            "thinking": function() { hold(driver(marks, "rippleDriver"), 0) },
            "speaking": function() { for (let i = 0; i < 3; i++) hold(speakDriver(marks, i), 0) }
        }
        for (const [from, to] of [["idle", "trouble"], ["trouble", "not-running"], ["not-running", "starting"],
                ["starting", "thinking"], ["thinking", "speaking"]]) {
            const before = onScreen(marks)
            marks.kind = to
            compare(onScreen(marks), before, from + " to " + to + " starts from the form on screen")
            if (to === "trouble") {
                for (let i = 0; i < 3; i++) verify(Qt.colorEqual(bar(marks, i).border.color, "white"))
                compare(driver(marks, "troubleDot").opacity, 0)
                // Behavior creates its animation at its first animated write.
                const glide = driver(marks, "glide")
                compare(glide.duration, 180)
                compare(glide.easing.type, Easing.OutCubic)
            }
            if (holdMoving[to]) holdMoving[to]()
            settle(marks, to)
        }

        marks.kind = "listening"
        const listen = driver(marks, "listenDriver")
        tryCompare(marks, "listenWeight", 1, 2000)
        tryVerify(function() { return listen.phase > 0.15 && listen.phase < 0.85 }, 2000)
        marks.kind = "idle"
        const phase = listen.phase
        const leaving = heights(marks)
        marks.kind = "listening"
        compare(listen.phase, phase, "re-entering listening resumes its held phase")
        compare(heights(marks), leaving)
        compare(listen.running, true)

        marks.kind = "speaking"
        tryCompare(marks, "speakWeight", 1, 2000)
        tryCompare(marks, "listenWeight", 0, 2000)
        for (let i = 0; i < 3; i++) hold(speakDriver(marks, i), 0.25)
        for (let i = 0; i < 3; i++) tryCompare(bar(marks, i), "height", [8, 9, 8][i], 2000, "speaking bar " + i)
        marks.kind = "idle"
        compare(heights(marks), [8, 9, 8], "leaving speaking starts from the moving bars")
        settle(marks, "idle")
        for (const phaseDriver of drivers(marks)) compare(phaseDriver.running, false, "settled idle " + phaseDriver.objectName)

        marks.kind = "thinking"
        compare(heights(marks), [6, 6, 6], "entering thinking starts from idle")
        compare(driver(marks, "rippleDriver").running, true)
    }
}
