# Design system

The current conversation uses native laptop audio, operated as [README.md](../README.md) describes. It has no browser client. The desktop notification pattern and approved future indicator and panel patterns live below.

This manual owns visual controls, interaction and accessibility. Spoken behaviour and product meaning stay with [AGENTS.md](../AGENTS.md#product) and the operation manual.

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

Verify actual display, readable text and native keyboard dismissal during the visual drive, applying the accessibility review required by the resume skill. Record unavailable observations or desktop suppression as limitations.

## Top bar indicator and conversation panel

The indicator sits in Omarchy's top bar immediately left of the clock, and the conversation panel is a floating window. Both are Quickshell surfaces.

### Colour

Kestrel defines no colour of its own. Every colour is a role read from the active Omarchy theme in `~/.local/state/omarchy/current/theme/`: the `shell.toml` key where the theme sets one, otherwise the `colors.toml` value. A `shell.toml` value that names another role resolves to that role.

| Role | `shell.toml` key | `colors.toml` fallback |
| --- | --- | --- |
| Bar background | `bar.background` | `background` |
| Bar text | `bar.text` | `foreground` |
| Bar active | `bar.active` | `red` |
| Popups background | `popups.background` | `background` |
| Popups text | `popups.text` | `foreground` |
| Accent | none | `accent` |
| Tooltip background, text and border | `tooltip.background`, `tooltip.text`, `tooltip.border` | `background`, `foreground`, `foreground` |

- A background role and the tooltip border are composed with the theme's alpha companion key where the theme sets one, and are fully opaque otherwise: `bar.background-alpha`, `popups.background-alpha`, `tooltip.background-alpha` and `tooltip.border-alpha`.
- Colours are read again when Omarchy switches theme. Omarchy replaces the theme directory whole and then rewrites `theme.name` beside it, so the reload watches `theme.name`; a watch on the files inside the directory does not survive the switch.
- Resting marks use their text role at 0.6 opacity. No other colour is derived.
- State is never carried by colour alone. Bar active marks trouble only; every other indicator state uses bar text.
- The desktop supplies the window border, the font family (`monospace`) and the window opacity. The panel draws no border of its own.

### Type and spacing

Dimensions and type sizes use Qt logical (device-independent) pixels at Omarchy base size 14, following [Qt's scaling model](https://doc.qt.io/qt-6/highdpi.html). This includes panel geometry and pointer targets. For the target-size audit, use Qt’s density-independent logical pixel as the native equivalent of a CSS (Cascading Style Sheets) reference pixel, following [World Wide Web Consortium guidance](https://www.w3.org/TR/wcag2ict-22/), and verify the rendered target at the actual display scale.

| Token | Value |
| --- | --- |
| Caption text | 12 |
| Body text | 14 |
| Title text | 16 |
| Body line height | 21 |
| Padding | 16 |
| Label gap | 5 |
| Control gap | 9 |
| Control height | 33 |
| Focus stroke | 2 |
| Bar height | 30 |

### The three marks

Three marks, each 3 wide with 3 between them, stand on a common baseline 9 above the bottom of the bar. The indicator's slot is 25 wide and the full bar height. The shape names the state.

| State | Shape | Motion |
| --- | --- | --- |
| Not running | One unbroken bar, 15 wide and 2 high, at 0.6 opacity | None |
| Idle | Three squares, 3 high, at 0.6 opacity | None |
| Listening | Three bars, 12 high | None |
| Thinking | Three squares, one raised by 5 | The raised square steps to the next position every 280 ms |
| Speaking | Three bars of unequal height | Each bar eases between 4 and 12 high, on periods of 420, 520 and 610 ms |
| Trouble | Two squares and an exclamation mark, a 7 high bar above a square, in bar active | None |

Where the desktop asks for reduced motion, nothing loops: thinking shows the middle square raised and still, and speaking shows bars 6, 12 and 8 high and still. The same holds for the marks in the panel header.

A click on the indicator opens the panel, and a second click closes it. Hovering shows the state in words:

| State | Tooltip |
| --- | --- |
| Not running | `Kestrel is not running. It is not holding the microphone.` |
| Idle | `Kestrel: idle. Microphone in use. Waiting for you to speak.` |
| Listening | `Kestrel: listening to you. Microphone in use.` |
| Thinking | `Kestrel: thinking about your message. Microphone in use.` |
| Speaking | `Kestrel: speaking. Microphone in use.` |
| Trouble | `Kestrel: brain trouble. A reply could not be completed. Microphone in use.` |

### Conversation panel

A floating window of fixed size, 448 by 640, which the owner moves with `Super` and a left drag.

- **Placement.** It opens with its outer edge inside the bottom right corner of the screen by the desktop's outer gap. It is placed once per opening, so a drag is not undone.
- **Closing.** The close button, `Escape` or a click on the indicator hides the panel. The conversation is kept for as long as Kestrel runs and is shown again when the panel opens.
- **Header.** The title `Kestrel` in bold title text, with the close button at the right. Beneath it, the status row: the three marks for the current state, the label gap, then the status sentence. Beneath that, the hint `Move: Super + left drag` in caption text.
- **Header marks.** The same drawing, sizes and motion as the bar, in popups text, with resting states at 0.6 opacity and trouble in bar active. They are decorative: no click, tooltip or keyboard focus, and hidden from assistive technology, because the sentence beside them says the state.
- **Conversation.** Kestrel's turns sit flush left under a bold `Kestrel` label in accent. The owner's turns are inset by 32 under a bold `You` label in popups text. The reply in progress shows the state word beside its label. A shared reference is an underlined accent link reading `Reference you shared:` and the host name. An incomplete reply ends with a warning triangle in accent and a sentence naming the problem.
- **Composer.** The label `Message` above a field 66 high with the placeholder `Type a message`. Beneath the field, `Enter to send` at the left and the `Send` button, 99 by 33, at the right. When sending is blocked, the reason replaces `Enter to send`.
- **Focus.** The focused control shows a ring of the focus stroke in accent.

| State | Status sentence |
| --- | --- |
| Not running | `Not running. Microphone released by Kestrel.` |
| Idle | `Idle. Microphone in use.` |
| Listening | `Listening. Microphone in use.` |
| Thinking | `Thinking. Microphone in use.` |
| Speaking | `Speaking. Microphone in use.` |
| Trouble | `Brain trouble. Microphone in use.` |

Every pointer target is at least 24 by 24.

### Native accessibility and verification

The first approved interface plan must specify native accessible roles, names and actions for controls, keyboard navigation, initial focus, closing and focus restoration. Use [Qt accessibility metadata](https://doc.qt.io/qt-6/accessible-qtquick.html) compatible with the installed Qt version, which the plan must verify. Decorative header marks remain excluded from assistive technology; the adjacent status sentence carries their meaning.

Before build, that plan must bind a verified reduced-motion preference source and the fallback when its signal is absent. A published desktop setting does not prove that the installed backend supplies it. Preserve the still shapes specified above when reduced motion is requested.

During the native visual drive, verify keyboard and assistive-technology interaction, pointer target dimensions at the actual display scale, enlarged text and long content. Check that text and controls remain readable and usable. Measure rendered text and control contrast after theme opacity and background composition; inherited theme roles alone are not evidence of sufficient contrast. Record unavailable observations as limitations. Follow the resume skill's visual and accessibility review requirements; browser scans and screenshots alone do not prove native accessibility.

Displayed microphone and status claims require supporting runtime evidence, including evidence for microphone release. Missing status does not establish release. Any new meaning or wording for unavailable status requires an owner decision before implementation.
