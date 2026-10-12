# Kestrel keeps its own voice and borrows its runtime

Kestrel needed tools, memory and task handling. We keep Kestrel's own listening and speaking, which the owner has tested and likes, and put Hermes Agent behind it as the runtime, because both sides already speak the same protocol and the tool loop, memory and approvals are the most work to build well.

## Considered options

Adopting Herald-OS whole, which bundles Hermes Agent with an Omarchy interface, was rejected: it is an alpha release, its authors have not run it on a real Omarchy machine, and it would replace the voice. Building our own runtime inside Kestrel is the fallback if the connected system feels slower than the prototype or the brain cannot use the runtime's tools reliably.

## Consequences

The standing promises "no tools" and "no persistent memory" end when the first tool is built, replaced by the privacy promises on issue #1, with owner sign-off and a security review at that point. The runtime's general terminal tool stays off.
