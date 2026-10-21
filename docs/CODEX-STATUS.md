# Local Codex job status

`desktop.codex_status.read_codex_status` reads one explicitly selected Codex job through the desktop app's private local socket. It returns a fresh, metadata-only observation for that call. The voice service does not call this adapter.

## Use

Import the library function and provide both the job identifier and the existing socket path chosen by the caller:

```python
from pathlib import Path

from desktop.codex_status import read_codex_status

status = read_codex_status("selected-job-id", socket_path=Path("/absolute/path/to/desktop.sock"))
```

The identifier must be 1 to 128 ASCII letters, digits, underscores or hyphens. The socket path must be absolute and point to an existing private Unix socket. The adapter does not discover a job or socket, use environment settings or fallbacks, create or repair endpoints, start the desktop app, or cache results. Call it again for another fresh observation.

The returned frozen `CodexStatus` contains only `thread_id`, `state`, `observed_at` and `reason`. `observed_at` is the local UTC receipt time. For `unavailable`, it marks the failed observation; it is not a successful source timestamp. On a successful read, it records when the local snapshot was received and makes no claim about provider state beyond that observation.

## Statuses and unavailable results

The `state` value is one of:

| State | Meaning |
|---|---|
| `working` | The selected job has an active status with no recognized wait flags. |
| `waiting_for_input` | The job is waiting for user input. |
| `waiting_for_approval` | The job is waiting for approval. |
| `waiting_for_input_and_approval` | Both wait flags are active. |
| `idle` | The desktop reports its explicit idle status. This does not establish that a job was accepted or completed. |
| `unavailable` | The selection, endpoint, transport, protocol data or bounded read did not support a trustworthy observation. |

Successful statuses have `reason=None`. Unavailable results have a fixed reason with advice for the observed category: invalid selection asks for one local job identifier; an unsafe endpoint asks for an existing private socket owned by this account; transport or owner failure asks to check the selected job and desktop app; incompatible data asks to check desktop protocol compatibility; and a read-limit refusal asks to check the desktop source before reading again. Source text and raw exceptions are not included in reasons.

The adapter reads a single snapshot and distinguishes native working and waiting statuses from explicit idle. Idle and turn completion are not proof of job acceptance, successful tests or merge. The adapter does not infer those outcomes.

## Local boundary and privacy

The adapter supports Linux Unix sockets for the current account. It requires a private 0700 parent directory, a 0600 socket, safe path components, stable endpoint identity across connection, and a peer process with the current account's user identifier. This admits by account ownership; it does not authenticate a particular desktop process or protect against malicious software running as the same account. Missing or unsafe endpoints produce an unavailable result without changing the endpoint.

The private desktop protocol is an implementation detail and may change with desktop app upgrades. Each call has a five-second observation deadline, bounded frames and total input, bounded nesting, and a short best-effort unsubscribe before closing the socket. If the protocol or limits prevent a supported snapshot, the result is unavailable. There is no performance guarantee.

The local transport delivers a full conversation object to the adapter before it projects the approved status fields. Conversation text and other fields are used transiently in memory; they are not returned, retained, logged or written to diagnostics. This is not a promise of secure memory erasure.

`read_codex_status` exposes no controls. The native socket protocol can accept controls, so the adapter sends only its fixed initialization, owner lookup and follow/unfollow operations needed for a read; it provides no arbitrary request or session-control interface.

This is an importable library only. It does not register a voice-service tool or provide inventory, GitHub, Claude, job mapping, command-line or monitoring features. Those require separate work.
