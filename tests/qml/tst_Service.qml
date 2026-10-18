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
