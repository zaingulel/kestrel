"""Fresh, explicit-selection status reads through the private desktop router."""

from dataclasses import dataclass
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import socket
import struct
import stat
import sys
import time
import uuid


_SELECTION = re.compile(r"[A-Za-z0-9_-]{1,128}\Z", re.ASCII)
_INVALID = "Invalid job selection. Select one local job identifier."
_UNSAFE = "Unsafe local endpoint. Select an existing private socket owned by this account."
_TRANSPORT = "Local job source unavailable. Check the selected job and desktop app."
_INCOMPATIBLE = "Incompatible local status data. Check desktop protocol compatibility."
_LIMIT = "Local status read exceeded its limits. Check the desktop source before reading again."


@dataclass(frozen=True)
class CodexStatus:
    thread_id: str | None
    state: str
    observed_at: datetime
    reason: str | None


class _Refused(Exception):
    pass


def _identity(value):
    return isinstance(value, str) and _SELECTION.fullmatch(value) is not None


def _project(status):
    if not isinstance(status, dict):
        raise _Refused(_INCOMPATIBLE)
    if status == {"type": "idle"}:
        return "idle"
    if set(status) != {"type", "activeFlags"} or status["type"] != "active":
        raise _Refused(_INCOMPATIBLE)
    flags = status["activeFlags"]
    if (not isinstance(flags, list) or any(
            flag not in ("waitingOnUserInput", "waitingOnApproval") for flag in flags)
            or len(flags) != len(set(flags))):
        raise _Refused(_INCOMPATIBLE)
    return {
        frozenset(): "working",
        frozenset(["waitingOnUserInput"]): "waiting_for_input",
        frozenset(["waitingOnApproval"]): "waiting_for_approval",
        frozenset(["waitingOnUserInput", "waitingOnApproval"]): "waiting_for_input_and_approval",
    }[frozenset(flags)]


def _endpoint(path):
    try:
        if sys.platform != "linux" or not isinstance(path, Path) or not path.is_absolute():
            raise _Refused(_UNSAFE)
        uid = os.getuid()
        for ancestor in reversed(path.parents):
            info = os.lstat(ancestor)
            if (not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, uid)
                    or (info.st_mode & 0o022 and not (
                        info.st_uid == 0 and info.st_mode & stat.S_ISVTX))):
                raise _Refused(_UNSAFE)
        parent = os.lstat(path.parent)
        endpoint = os.lstat(path)
        if (parent.st_uid != uid or stat.S_IMODE(parent.st_mode) != 0o700
                or not stat.S_ISSOCK(endpoint.st_mode) or endpoint.st_uid != uid
                or stat.S_IMODE(endpoint.st_mode) != 0o600):
            raise _Refused(_UNSAFE)
        return ((parent.st_dev, parent.st_ino), (endpoint.st_dev, endpoint.st_ino))
    except OSError:
        raise _Refused(_UNSAFE) from None


def _remaining(deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise _Refused(_LIMIT)
    return remaining


def _send(connection, message, deadline):
    body = json.dumps(message).encode("utf-8")
    if len(body) + 4 > 4096:
        raise _Refused(_LIMIT)
    connection.settimeout(_remaining(deadline))
    connection.sendall(struct.pack("<I", len(body)) + body)
    _remaining(deadline)


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise _Refused(_INCOMPATIBLE)
        result[key] = value
    return result


def _finite(value):
    number = float(value)
    if not math.isfinite(number):
        raise _Refused(_INCOMPATIBLE)
    return number


def _nesting(value, depth=0):
    if depth > 64:
        raise _Refused(_INCOMPATIBLE)
    if isinstance(value, (dict, list)):
        for child in value.values() if isinstance(value, dict) else value:
            _nesting(child, depth + 1)


class _IncomingFrames:
    def __init__(self, connection, deadline):
        self.connection = connection
        self.deadline = deadline
        self.frames = 0
        self.bytes = 0

    def exact(self, size):
        if self.bytes + size > 16 * 1024 * 1024:
            raise _Refused(_LIMIT)
        result = bytearray()
        while len(result) < size:
            self.connection.settimeout(_remaining(self.deadline))
            chunk = self.connection.recv(size - len(result))
            _remaining(self.deadline)
            if not chunk:
                raise _Refused(_TRANSPORT)
            self.bytes += len(chunk)
            result.extend(chunk)
        return result

    def receive(self):
        if self.frames >= 64:
            raise _Refused(_LIMIT)
        self.frames += 1
        size, = struct.unpack("<I", self.exact(4))
        if not 0 < size <= 8 * 1024 * 1024:
            raise _Refused(_LIMIT)
        try:
            message = json.loads(self.exact(size).decode("utf-8"), object_pairs_hook=_object,
                                 parse_constant=_finite, parse_float=_finite)
            _nesting(message)
            _remaining(self.deadline)
        except (ValueError, UnicodeError, RecursionError):
            raise _Refused(_INCOMPATIBLE) from None
        if not isinstance(message, dict):
            raise _Refused(_INCOMPATIBLE)
        return message


def _recipient(envelope, client):
    if "targetClientIds" not in envelope:
        return True
    recipients = envelope["targetClientIds"]
    return (isinstance(recipients, list) and client in recipients
            and all(_identity(value) for value in recipients))


def _request(connection, incoming, client, method, version, params):
    request_id = str(uuid.uuid4())
    _send(connection, {
        "type": "request", "sourceClientId": client, "requestId": request_id,
        "version": version, "method": method, "params": params,
        "timeoutMs": max(1, int(_remaining(incoming.deadline) * 1000)),
    }, incoming.deadline)
    while True:
        message = incoming.receive()
        if message.get("type") == "response" and message.get("requestId") == request_id:
            if (message.get("method") != method or message.get("resultType") != "success"
                    or not _identity(message.get("handledByClientId"))):
                raise _Refused(_TRANSPORT)
            return message


def read_codex_status(thread_id: str, *, socket_path: Path) -> CodexStatus:
    """Return minimal status metadata; this call has no session-control authority."""
    if not _identity(thread_id):
        return CodexStatus(None, "unavailable", datetime.now(timezone.utc), _INVALID)
    connection = None
    following = None
    try:
        deadline = time.monotonic() + 5
        identity = _endpoint(socket_path)
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.settimeout(_remaining(deadline))
        connection.connect(str(socket_path))
        _remaining(deadline)
        if _endpoint(socket_path) != identity:
            raise _Refused(_UNSAFE)
        _, peer_uid, _ = struct.unpack("3i", connection.getsockopt(
            socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
        if peer_uid != os.getuid():
            raise _Refused(_UNSAFE)
        incoming = _IncomingFrames(connection, deadline)
        registration = _request(connection, incoming, "initializing-client", "initialize", 0,
                                {"clientType": "kestrel-status"})
        result = registration.get("result")
        if (not isinstance(result, dict) or not _identity(result.get("clientId"))
                or registration["handledByClientId"] != result["clientId"]):
            raise _Refused(_INCOMPATIBLE)
        client = result["clientId"]
        owner = _request(connection, incoming, client, "thread-owner-discovery", 1,
                         {"hostId": "local", "conversationId": thread_id})["handledByClientId"]
        following = {
            "type": "broadcast", "sourceClientId": client, "version": 1,
            "method": "thread-stream-following-changed", "targetClientIds": [owner],
            "params": {"conversationId": thread_id, "hostId": "local", "following": True},
        }
        _send(connection, following, deadline)
        while True:
            message = incoming.receive()
            if (message.get("type") != "broadcast"
                    or message.get("method") != "thread-stream-state-changed"):
                continue
            params = message.get("params")
            if not isinstance(params, dict):
                raise _Refused(_INCOMPATIBLE)
            change = params.get("change")
            if not isinstance(change, dict) or change.get("type") != "snapshot":
                continue
            state = change.get("conversationState")
            revision = change.get("revision")
            if (message.get("version") != 11 or message.get("sourceClientId") != owner
                    or params.get("hostId") != "local" or params.get("conversationId") != thread_id
                    or type(revision) is not int or revision < 0
                    or not isinstance(state, dict) or state.get("id") != thread_id
                    or state.get("hostId") != "local"
                    or not all(_recipient(envelope, client) for envelope in (message, params))):
                raise _Refused(_INCOMPATIBLE)
            projected = _project(state.get("threadRuntimeStatus"))
            _remaining(deadline)
            return CodexStatus(thread_id, projected, datetime.now(timezone.utc), None)
    except _Refused as error:
        return CodexStatus(thread_id, "unavailable", datetime.now(timezone.utc), error.args[0])
    except TimeoutError:
        return CodexStatus(thread_id, "unavailable", datetime.now(timezone.utc), _LIMIT)
    except (OSError, ValueError, TypeError, RecursionError):
        return CodexStatus(thread_id, "unavailable", datetime.now(timezone.utc), _TRANSPORT)
    finally:
        if connection is not None:
            try:
                if following is not None:
                    cleanup_deadline = time.monotonic() + 0.25
                    following["params"]["following"] = False
                    _send(connection, following, cleanup_deadline)
            except (OSError, _Refused):
                pass
            finally:
                connection.close()
