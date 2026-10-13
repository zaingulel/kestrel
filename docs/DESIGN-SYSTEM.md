# Design system

The current browser interface is Pipecat's test client, operated as [README.md](../README.md) describes. The browser interface has no local tokens or reusable component patterns. Factory adoption preserves that interface.

Product discovery and drilling with the owner precede interface design or implementation. An approved interface plan must establish its tokens and patterns here before building, as [AGENTS.md](../AGENTS.md) and the resume skill require.

## Native mute failure notification

Use the installed desktop's native notification component, inheriting its color, typography, spacing and placement. Kestrel adds no theme tokens, layout, custom controls or desktop configuration.

| Property | Value |
| --- | --- |
| Application name | `Kestrel` |
| Summary | `Mute could not be confirmed` |
| Body | `Check the audio control. Kestrel will not retry.` |
| Hints | Transient; `boolean:suppress-sound:true` |

The notification contains only this fixed status text, with no transcript, output name, command output, actions, custom icon or markup. Ordinary desktop notification settings apply; an unavailable notification service or suppression does not establish delivery.

Verify actual display, readable text and native keyboard dismissal during the visual drive, applying the accessibility review required by the resume skill. Record unavailable observations or desktop suppression as limitations. Kestrel's browser client is unchanged.
