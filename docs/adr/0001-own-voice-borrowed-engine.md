# Kestrel keeps its own voice and borrows its engine

Kestrel needed tools, memory and task handling. We keep Kestrel's own listening and speaking, which the owner has tested and likes, and put Hermes Agent behind it as the engine, because Hermes Agent offers the kind of connection Kestrel already uses to reach its brain, and the tool loop, memory and approvals are the most work to build well. Whether that connection works as hoped is proven in the experiment's connection step, not assumed here.

## Considered options

Adopting Herald-OS whole, which bundles Hermes Agent with an Omarchy interface, was rejected: it is an alpha release, its authors have not run it on a real Omarchy machine, and it would replace the voice. Building our own engine inside Kestrel is the fallback if the connected system feels slower than the prototype or the brain cannot use the engine's tools reliably.

## Consequences

The standing promises "no tools" and "no persistent memory" end when the first tool is built, replaced by the privacy promises on issue #1, with owner sign-off and a security review at that point. The engine's general terminal tool stays off.
