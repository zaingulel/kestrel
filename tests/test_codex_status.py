import contextlib
import dataclasses
import io
import json
import os
from pathlib import Path
import socket
import struct
import tempfile
import threading
import unittest
from unittest import mock
import uuid
from datetime import datetime, timezone


THREAD = "selected-job"
CLIENT = "registered-reader"
OWNER = "selected-owner"


def framed(value):
    body = json.dumps(value).encode("utf-8")
    return struct.pack("<I", len(body)) + body


def receive(connection):
    def exact(size):
        result = b""
        while len(result) < size:
            chunk = connection.recv(size - len(result))
            if not chunk:
                raise EOFError
            result += chunk
        return result
    size, = struct.unpack("<I", exact(4))
    return json.loads(exact(size))


def snapshot(status):
    return {
        "type": "broadcast", "sourceClientId": OWNER,
        "method": "thread-stream-state-changed", "version": 11,
        "targetClientIds": [CLIENT],
        "params": {
            "hostId": "local", "conversationId": THREAD,
            "targetClientIds": [CLIENT],
            "change": {"type": "snapshot", "revision": 0, "conversationState": {
                "id": THREAD, "hostId": "local", "threadRuntimeStatus": status,
            }},
        },
    }


class UnixPeer:
    """Independent wire framing, outbound ledger and EOF observation."""

    def __init__(self, status, *, incoming=None, close_output=False, response_edit=None, raw_follow=False):
        self.status = status
        self.incoming = incoming
        self.close_output = close_output
        self.response_edit = response_edit
        self.raw_follow = raw_follow
        self.raw_tail = bytearray()
        self.ledger = []
        self.eof = False
        self.errors = []

    def __enter__(self):
        self.home = tempfile.TemporaryDirectory(prefix="kestrel-status-")
        self.path = Path(self.home.name) / "ipc.sock"
        try:
            self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.listener.settimeout(2)
            self.listener.bind(str(self.path))
            os.chmod(self.path, 0o600)
            self.listener.listen(1)
            self.worker = threading.Thread(target=self.serve, daemon=True)
            self.worker.start()
            return self
        except BaseException:
            self.listener.close()
            self.home.cleanup()
            raise

    def serve(self):
        try:
            with self.listener.accept()[0] as connection:
                connection.settimeout(2)
                for method, result in (
                    ("initialize", {"clientId": CLIENT}),
                    ("thread-owner-discovery", {"supportsUntrustedAppInput": True}),
                ):
                    request = receive(connection)
                    self.ledger.append(request)
                    response = {
                        "type": "response", "requestId": request["requestId"],
                        "method": method, "resultType": "success",
                        "handledByClientId": CLIENT if method == "initialize" else OWNER,
                        "result": result,
                    }
                    if self.response_edit is not None:
                        self.response_edit(method, response)
                    connection.sendall(framed(response))
                if self.raw_follow:
                    while chunk := connection.recv(4096):
                        self.raw_tail.extend(chunk)
                    self.eof = True
                    return
                self.ledger.append(receive(connection))
                for payload in self.incoming if self.incoming is not None else [framed(snapshot(self.status))]:
                    connection.sendall(payload)
                if self.close_output:
                    connection.shutdown(socket.SHUT_WR)
                while True:
                    self.ledger.append(receive(connection))
        except (EOFError, ConnectionResetError, BrokenPipeError):
            self.eof = True
        except BaseException as error:
            self.errors.append(type(error).__name__)

    def __exit__(self, *unused):
        self.worker.join(3)
        self.listener.close()
        self.home.cleanup()
        if self.worker.is_alive() or self.errors:
            raise AssertionError(f"peer did not finish cleanly: {self.errors}")


class CodexStatusTests(unittest.TestCase):
    def test_selected_snapshot_and_both_waits(self):
        from codex_status import read_codex_status

        # Native sanitized observations and #175 define these literal outcomes.
        statuses = (
            ({"type": "active", "activeFlags": []}, "working"),
            ({"type": "active", "activeFlags": ["waitingOnUserInput"]}, "waiting_for_input"),
            ({"type": "active", "activeFlags": ["waitingOnApproval"]}, "waiting_for_approval"),
            ({"type": "active", "activeFlags": ["waitingOnApproval", "waitingOnUserInput"]},
             "waiting_for_input_and_approval"),
            ({"type": "idle"}, "idle"),
        )
        for native, expected in statuses:
            with self.subTest(state=expected), UnixPeer(native) as peer:
                before = datetime.now(timezone.utc)
                result = read_codex_status(THREAD, socket_path=peer.path)
                after = datetime.now(timezone.utc)
                self.assertEqual(result.thread_id, THREAD)
                self.assertEqual(result.state, expected)
                self.assertIsNone(result.reason)
                self.assertEqual(result.observed_at.tzinfo, timezone.utc)
                self.assertLessEqual(before, result.observed_at)
                self.assertLessEqual(result.observed_at, after)
                self.assertEqual({field.name for field in dataclasses.fields(result)},
                                 {"thread_id", "state", "observed_at", "reason"})
                with self.assertRaises(dataclasses.FrozenInstanceError):
                    result.state = "idle"
            self.assertTrue(peer.eof)

    def test_only_read_protocol_is_sent(self):
        from codex_status import read_codex_status

        inbound = [
            {"type": "request", "requestId": "untrusted-request", "method": "thread-owner-discovery"},
            {"type": "request", "requestId": "control-request", "method": "thread-follower-interrupt-turn"},
            {"type": "broadcast", "method": "unrelated"},
            {"type": "broadcast", "method": "thread-stream-state-changed", "params": {
                "change": {"type": "patches", "patches": [{"opaque": "ignore"}]}}},
            snapshot({"type": "idle"}),
        ]
        with UnixPeer(None, incoming=[framed(item) for item in inbound]) as peer:
            result = read_codex_status(THREAD, socket_path=peer.path)
        self.assertEqual(result.state, "idle")
        self.assertTrue(peer.eof)
        self.assertEqual(len(peer.ledger), 4)
        first, discover, follow, unfollow = peer.ledger
        for request in (first, discover):
            self.assertEqual(str(uuid.UUID(request["requestId"])), request["requestId"])
            self.assertEqual(set(request), {"type", "sourceClientId", "requestId", "version",
                                            "method", "params", "timeoutMs"})
            self.assertEqual(request["type"], "request")
            self.assertGreater(request["timeoutMs"], 0)
            self.assertLessEqual(request["timeoutMs"], 5000)
        self.assertNotEqual(first["requestId"], discover["requestId"])
        self.assertEqual((first["sourceClientId"], first["version"], first["method"], first["params"]),
                         ("initializing-client", 0, "initialize", {"clientType": "kestrel-status"}))
        self.assertEqual((discover["sourceClientId"], discover["version"], discover["method"], discover["params"]),
                         (CLIENT, 1, "thread-owner-discovery", {"hostId": "local", "conversationId": THREAD}))
        for envelope, value in ((follow, True), (unfollow, False)):
            self.assertEqual(envelope, {
                "type": "broadcast", "sourceClientId": CLIENT, "version": 1,
                "method": "thread-stream-following-changed", "targetClientIds": [OWNER],
                "params": {"conversationId": THREAD, "hostId": "local", "following": value},
            })
        with self.assertRaises(TypeError):
            read_codex_status(THREAD, socket_path=peer.path, method="thread-follower-interrupt-turn")

    def test_content_never_escapes(self):
        from codex_status import read_codex_status

        sentinel = "PRIVATE_CONTENT_SENTINEL_175"
        full = snapshot({"type": "active", "activeFlags": []})
        full["params"]["change"]["conversationState"].update({
            "title": sentinel, "turns": [{"text": sentinel}],
            "requests": [{"params": {"command": sentinel}}],
            "instructions": sentinel, "toolArguments": {"text": sentinel},
        })
        invalid = snapshot({"type": sentinel})
        output, diagnostics = io.StringIO(), io.StringIO()
        results = []
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(diagnostics):
            for payload, state in ((framed(full), "working"), (framed(invalid), "unavailable"),
                                   (struct.pack("<I", len(sentinel)) + sentinel.encode(), "unavailable")):
                with UnixPeer(None, incoming=[payload]) as peer:
                    result = read_codex_status(THREAD, socket_path=peer.path)
                self.assertEqual(result.state, state)
                results.append(result)
            results.append(read_codex_status(sentinel + "!", socket_path=Path("/absent")))
        for result in results:
            self.assertNotIn(sentinel, repr(result))
            self.assertNotIn(sentinel, json.dumps(dataclasses.asdict(result), default=str))
            if result.state == "unavailable":
                self.assertIsInstance(result.reason, str)
                self.assertTrue(result.reason)
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(diagnostics.getvalue(), "")

    def test_unsafe_endpoint_never_connects(self):
        from codex_status import read_codex_status

        with tempfile.TemporaryDirectory(prefix="kestrel-status-admission-") as home:
            root = Path(home)
            private = root / "private"
            private.mkdir(mode=0o700)
            path = private / "ipc.sock"
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
                listener.bind(str(path))
                os.chmod(path, 0o600)
                link = root / "linked"
                link.symlink_to(private, target_is_directory=True)
                leaf = private / "alias.sock"
                leaf.symlink_to(path)
                regular = private / "regular"
                regular.write_text("not a socket")
                cases = [Path("relative.sock"), root / "missing", root / "nul\x00socket", regular, leaf,
                         link / "ipc.sock", regular / "ipc.sock"]
                for bad in cases:
                    with self.subTest(path=str(bad)), mock.patch("socket.socket", side_effect=OSError("admission must precede socket")) as constructor:
                        result = read_codex_status(THREAD, socket_path=bad)
                        self.assertEqual(result.state, "unavailable")
                        self.assertEqual(result.reason, "Unsafe local endpoint. Select an existing private socket owned by this account.")
                        constructor.assert_not_called()
                for target, mode, restore in ((private, 0o750, 0o700), (path, 0o660, 0o600),
                                              (root, 0o770, 0o700)):
                    os.chmod(target, mode)
                    try:
                        with self.subTest(mode=mode), mock.patch("socket.socket", side_effect=OSError("admission must precede socket")) as constructor:
                            result = read_codex_status(THREAD, socket_path=path)
                            self.assertEqual(result.state, "unavailable")
                            constructor.assert_not_called()
                            self.assertEqual(target.stat().st_mode & 0o7777, mode)
                    finally:
                        os.chmod(target, restore)
                original_lstat = os.lstat
                for foreign in (private, path):
                    def wrong_owner(name, *args, **kwargs):
                        value = original_lstat(name, *args, **kwargs)
                        if Path(name) == foreign:
                            fields = list(value)
                            fields[4] = os.getuid() + 1
                            return os.stat_result(fields)
                        return value
                    with self.subTest(owner=str(foreign)), mock.patch("os.lstat", side_effect=wrong_owner), mock.patch("socket.socket", side_effect=OSError("admission must precede socket")) as constructor:
                        self.assertEqual(read_codex_status(THREAD, socket_path=path).state, "unavailable")
                        constructor.assert_not_called()
                for bad_id in ("", "x" * 129, "has/slash", "unicode-é", None, True):
                    with self.subTest(selection=bad_id), mock.patch("socket.socket", side_effect=OSError("admission must precede socket")) as constructor:
                        result = read_codex_status(bad_id, socket_path=path)
                        self.assertEqual((result.state, result.thread_id), ("unavailable", None))
                        constructor.assert_not_called()

        real_socket = socket.socket
        for changed in ("socket", "parent", "peer"):
            held = []
            with self.subTest(changed=changed), UnixPeer({"type": "idle"}) as peer:
                connected = False
                original_lstat = os.lstat

                def changed_identity(name, *args, **kwargs):
                    value = original_lstat(name, *args, **kwargs)
                    target = peer.path if changed == "socket" else peer.path.parent
                    if connected and Path(name) == target and changed != "peer":
                        fields = list(value)
                        fields[1] += 1
                        return os.stat_result(fields)
                    return value

                class SocketBoundary:
                    def __init__(self, *args, **kwargs):
                        self.actual = real_socket(*args, **kwargs)
                        held.append(self.actual)

                    def __getattr__(self, name):
                        return getattr(self.actual, name)

                    def connect(self, endpoint):
                        nonlocal connected
                        self.actual.connect(endpoint)
                        connected = True

                    def getsockopt(self, level, option, size):
                        if changed == "peer":
                            return struct.pack("3i", os.getpid(), os.getuid() + 1, os.getgid())
                        return self.actual.getsockopt(level, option, size)

                with mock.patch("os.lstat", side_effect=changed_identity), mock.patch("socket.socket", side_effect=lambda *args, **kwargs: real_socket(*args, **kwargs) if "fileno" in kwargs else SocketBoundary(*args, **kwargs)):
                    result = read_codex_status(THREAD, socket_path=peer.path)
                self.assertEqual(result.state, "unavailable")
                self.assertTrue(held)
                self.assertTrue(all(connection.fileno() == -1 for connection in held))
            self.assertEqual(peer.ledger, [])
            self.assertTrue(peer.eof)

    def test_hostile_wire_is_unavailable(self):
        from codex_status import read_codex_status

        incompatible = "Incompatible local status data. Check desktop protocol compatibility."
        limited = "Local status read exceeded its limits. Check the desktop source before reading again."
        transport = "Local job source unavailable. Check the selected job and desktop app."
        cases = []
        bad_statuses = [None, {}, [], {"type": "notLoaded"}, {"type": "systemError"},
                        {"type": "unknown"}, {"type": "active"},
                        {"type": "idle", "activeFlags": []}, {"type": "idle", "newField": True},
                        {"type": "active", "activeFlags": "waitingOnApproval"},
                        {"type": "active", "activeFlags": ["futureFlag"]},
                        {"type": "active", "activeFlags": ["waitingOnApproval", "waitingOnApproval"]},
                        {"type": "active", "activeFlags": [{}]},
                        {"type": "active", "activeFlags": [], "newField": True}]
        cases.extend((f"status-{index}", [framed(snapshot(status))], incompatible)
                     for index, status in enumerate(bad_statuses))
        corrupt_fields = [
            (("sourceClientId",), "different-owner"), (("version",), 10),
            (("targetClientIds",), ["different-recipient"]),
            (("targetClientIds",), CLIENT),
            (("params", "hostId"), "remote"), (("params", "conversationId"), "different-job"),
            (("params", "targetClientIds"), ["different-recipient"]),
            (("params", "targetClientIds"), None),
            (("params", "change", "revision"), True), (("params", "change", "revision"), -1),
            (("params", "change", "revision"), 1.5),
            (("params", "change", "conversationState"), []),
            (("params", "change", "conversationState", "id"), "different-job"),
            (("params", "change", "conversationState", "hostId"), "remote"),
        ]
        for path, value in corrupt_fields:
            message = snapshot({"type": "idle"})
            part = message
            for field in path[:-1]:
                part = part[field]
            part[path[-1]] = value
            cases.append(("/".join(path) + repr(value), [framed(message)], incompatible))
        raw_json = [b"{", b"[]", b'{"type":"broadcast","type":"response"}',
                    b'{"number":NaN}', b'{"number":Infinity}', b'{"number":-Infinity}',
                    b'"' + bytes([255]) + b'"', b'[' * 100 + b'0' + b']' * 100]
        cases.extend((f"json-{index}", [struct.pack("<I", len(body)) + body], incompatible)
                     for index, body in enumerate(raw_json))
        cases.extend([
            ("empty-frame", [struct.pack("<I", 0)], limited),
            ("oversize-advertisement", [struct.pack("<I", 8 * 1024 * 1024 + 1)], limited),
            ("truncated-header", [b"xx"], transport),
            ("truncated-body", [struct.pack("<I", 20) + b"{}"], transport),
            ("frame-flood", [framed({"type": "notification"})] * 62 + [framed(snapshot({"type": "idle"}))], limited),
            ("total-byte-flood", [framed({"type": "notification", "ignored": "x" * (6 * 1024 * 1024)})] * 3
             + [framed(snapshot({"type": "idle"}))], limited),
        ])
        for label, incoming, reason in cases:
            with self.subTest(case=label), UnixPeer(None, incoming=incoming, close_output=True) as peer:
                result = read_codex_status(THREAD, socket_path=peer.path)
                self.assertEqual((result.state, result.reason), ("unavailable", reason))
            self.assertTrue(peer.eof)

        for method, field, value in (
            ("initialize", "method", "different-method"),
            ("initialize", "resultType", "error"),
            ("initialize", "handledByClientId", "different-client"),
            ("initialize", "result", {"clientId": "x" * 129}),
            ("thread-owner-discovery", "method", "different-method"),
            ("thread-owner-discovery", "handledByClientId", ""),
            ("thread-owner-discovery", "resultType", "error"),
        ):
            def corrupt_response(current, response):
                if current == method:
                    response[field] = value
            with self.subTest(response=(method, field)), UnixPeer({"type": "idle"}, response_edit=corrupt_response) as peer:
                result = read_codex_status(THREAD, socket_path=peer.path)
                self.assertEqual(result.state, "unavailable")
            self.assertTrue(peer.eof)

        # The shared allowance includes registration and discovery, leaving 62 frames.
        with UnixPeer(None, incoming=[framed({"type": "notification"})] * 61
                      + [framed(snapshot({"type": "idle"}))]) as peer:
            self.assertEqual(read_codex_status(THREAD, socket_path=peer.path).state, "idle")

    def test_failure_discards_previous_success(self):
        from codex_status import read_codex_status

        with UnixPeer({"type": "active", "activeFlags": []}) as peer:
            first = read_codex_status(THREAD, socket_path=peer.path)
        before = datetime.now(timezone.utc)
        failed = read_codex_status(THREAD, socket_path=peer.path)
        after = datetime.now(timezone.utc)
        self.assertEqual(first.state, "working")
        self.assertEqual((failed.thread_id, failed.state), (THREAD, "unavailable"))
        self.assertIsNotNone(failed.reason)
        self.assertLessEqual(before, failed.observed_at)
        self.assertLessEqual(failed.observed_at, after)
        with UnixPeer({"type": "active", "activeFlags": ["waitingOnUserInput"]}) as fresh:
            recovered = read_codex_status(THREAD, socket_path=fresh.path)
        self.assertEqual(recovered.state, "waiting_for_input")
        self.assertIsNone(recovered.reason)
        self.assertTrue(peer.eof)
        self.assertTrue(fresh.eof)
        self.assertNotEqual(peer.ledger[0]["requestId"], fresh.ledger[0]["requestId"])

    def test_deadline_and_cleanup(self):
        from codex_status import read_codex_status

        real_socket = socket.socket
        limited = "Local status read exceeded its limits. Check the desktop source before reading again."
        for phase in ("success", "refusal", "connect-deadline", "write-deadline", "read-deadline",
                      "shared-deadline", "partial-follow", "interruption", "cleanup-failure"):
            now = [100.0]
            held, sent, timeouts = [], [], []
            status = {"type": "unknown"} if phase == "refusal" else {"type": "idle"}
            with self.subTest(phase=phase), UnixPeer(status, raw_follow=phase == "partial-follow") as peer:
                class SocketBoundary:
                    def __init__(self, *args, **kwargs):
                        self.actual = real_socket(*args, **kwargs)
                        held.append(self.actual)
                        self_test.addCleanup(self.actual.close)

                    def __getattr__(self, name):
                        return getattr(self.actual, name)

                    def settimeout(self, value):
                        timeouts.append(value)
                        self.actual.settimeout(value)

                    def connect(self, endpoint):
                        self.actual.connect(endpoint)
                        if phase == "connect-deadline":
                            now[0] += 5.1
                        elif phase == "shared-deadline":
                            now[0] += 1

                    def sendall(self, data):
                        envelope = json.loads(data[4:])
                        sent.append(envelope)
                        is_follow = envelope["method"] == "thread-stream-following-changed"
                        if is_follow and not envelope["params"]["following"]:
                            if phase == "cleanup-failure":
                                raise OSError("private cleanup diagnostic")
                            self.actual.sendall(data)
                            return
                        if is_follow and phase == "partial-follow":
                            self.actual.sendall(data[:6])
                            raise OSError("private partial-write diagnostic")
                        self.actual.sendall(data)
                        if phase == "write-deadline":
                            now[0] += 5.1
                        elif phase == "shared-deadline":
                            now[0] += 1

                    def recv(self, size):
                        data = self.actual.recv(size)
                        if b'"thread-stream-state-changed"' in data:
                            if phase == "interruption":
                                raise KeyboardInterrupt
                            if phase == "read-deadline":
                                now[0] += 5.1
                            elif phase == "shared-deadline":
                                now[0] += 1.1
                        return data

                self_test = self
                constructor = lambda *args, **kwargs: real_socket(*args, **kwargs) if "fileno" in kwargs else SocketBoundary(*args, **kwargs)
                with mock.patch("socket.socket", side_effect=constructor), mock.patch("time.monotonic", side_effect=lambda: now[0]):
                    if phase == "interruption":
                        with self.assertRaises(KeyboardInterrupt):
                            read_codex_status(THREAD, socket_path=peer.path)
                        result = None
                    else:
                        result = read_codex_status(THREAD, socket_path=peer.path)
                self.assertTrue(held)
                self.assertTrue(all(connection.fileno() == -1 for connection in held))
                if phase in ("success", "cleanup-failure"):
                    self.assertEqual(result.state, "idle")
                elif phase != "interruption":
                    self.assertEqual(result.state, "unavailable")
                    if "deadline" in phase:
                        self.assertEqual(result.reason, limited)
                followed = any(message.get("params", {}).get("following") is True for message in sent)
                if followed and phase != "partial-follow":
                    self.assertIs(sent[-1]["params"]["following"], False)
                    self.assertGreater(timeouts[-1], 0)
                    self.assertLessEqual(timeouts[-1], 0.25)
                self.assertTrue(all(0 < value <= 5 for value in timeouts))
                if phase == "shared-deadline":
                    self.assertTrue(any(0 < value <= 1 for value in timeouts[:-1]))
            self.assertTrue(peer.eof)
            if phase == "partial-follow":
                self.assertEqual(peer.raw_tail, framed(sent[-1])[:6])
                self.assertIs(sent[-1]["params"]["following"], True)


if __name__ == "__main__":
    unittest.main()
