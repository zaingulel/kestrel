# Design system

The current conversation uses native laptop audio, operated as [README.md](../README.md) describes. It has no browser client. The desktop notification, native indicator and conversation panel patterns live below.

This manual owns visual controls, interaction and accessibility. Spoken behaviour and product meaning stay with [AGENTS.md](../AGENTS.md#product) and the operation manual.

Product discovery and drilling with the owner precede interface design or implementation. An approved interface plan must establish its tokens and patterns here before building, as [AGENTS.md](../AGENTS.md) and the resume skill require.

## Native audio failure notification

Use the installed desktop's native notification component, inheriting its color, typography, spacing and placement. Kestrel adds no theme tokens, layout, custom controls or desktop configuration.

| Property | Value |
| --- | --- |
| Application name | `Kestrel` |
| Summary | `Mute could not be confirmed` or `Volume could not be confirmed`, matching the failed action |
| Body | `Check the audio control. Kestrel will not retry.` |
| Hints | Transient; `boolean:suppress-sound:true` |

The notification contains only this fixed status text, with no transcript, output name, command output, actions, custom icon or markup. Ordinary desktop notification settings apply; an unavailable notification service or suppression does not establish delivery.

Verify actual display, readable text and native keyboard dismissal during the visual drive, applying the accessibility review required by the resume skill. Record unavailable observations or desktop suppression as limitations.

## Top bar indicator and conversation panel

The indicator sits in Omarchy's top bar immediately left of the clock, and the conversation panel is a floating window. Both are Quickshell surfaces.

### Colour

Kestrel defines no colour of its own. It binds the native host's reactive `Color` palette, which resolves the active Omarchy theme's `shell.toml` roles and `colors.toml` fallbacks. Text roles use `Color.flatColor(Color.pick(key, fallback), fallback)` so role aliases resolve through the host. Backgrounds and tooltips use the host's composed roles and native tooltip component.

| Role | `shell.toml` key | `colors.toml` fallback |
| --- | --- | --- |
| Bar background | `bar.background` | `background` |
| Bar text | `bar.text` | `foreground` |
| Bar active | `bar.active` | Host urgent (`red`) |
| Popups background | `popups.background` | `background` |
| Popups text | `popups.text` | `foreground` |
| Accent | none | `accent` |
| Tooltip background, text and border | `tooltip.background`, `tooltip.text`, `tooltip.border` | `background`, `foreground`, `foreground` |

- A background role and the tooltip border are composed with the theme's alpha companion key where the theme sets one, and are fully opaque otherwise: `bar.background-alpha`, `popups.background-alpha`, `tooltip.background-alpha` and `tooltip.border-alpha`.
- Native palette bindings update when the host applies a theme through its shell interface. Kestrel does not parse theme files or watch `theme.name`.
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
| Panel width | 448 |
| Panel height | 640 |
| Owner turn inset | 32 |
| Close control minimum side | 33 |

Panel text follows the host's text size. The panel's text scale is the host `Style.fontScale` multiplied by 12/14, so host base size 14 gives exactly the token values above and base size 28 doubles them; a scale that is not a finite positive number falls back to 1. Caption, body and title text, the body line height and the transcript's one-line scroll step are each the token value times the scale, rounded to the nearest pixel and at least 1. The close control stays square, each side the larger of 33 and its glyph's larger rendered extent plus both sides of the focus stroke, and the title row takes the taller of the close control and the title. Panel size, padding, gaps, inset, focus stroke and the marks stay fixed: text wraps within them and the transcript scrolls in the space that remains.

### The three marks

Three marks, each 3 wide with 3 between them, stand on a common baseline 9 above the bottom of the bar. The indicator's slot is 25 wide and the full bar height. The shape names the state.

| State | Shape | Motion |
| --- | --- | --- |
| Not running | One unbroken bar, 15 wide and 2 high, at 0.6 opacity | None |
| Starting | Three outlined 3 by 3 squares with 1-pixel strokes, at full bar-text opacity | None |
| Status unavailable | Three 3 by 3 squares raised left-to-right by 0, 3 and 6, at full bar-text opacity | None |
| Idle | Three squares, 3 high, at 0.6 opacity | None |
| Listening | Three bars, 12 high | None |
| Thinking | Three squares, one raised by 5 | The raised square steps to the next position every 280 ms |
| Speaking | Three bars of unequal height | Each bar eases between 4 and 12 high, on periods of 420, 520 and 610 ms |
| Trouble | Two squares and an exclamation mark, a 7 high bar above a square, in bar active | None |

Where the desktop asks for reduced motion, nothing loops: thinking shows the middle square raised and still, and speaking shows bars 6, 12 and 8 high and still. The same holds for the marks in the panel header.

The status indicator is an accessible button named `Open conversation` or `Close conversation`, followed by the status sentence and any placement advisory. Its 25 by 30 slot is the click target. Its marks are decorative and excluded from assistive technology. Pressing it toggles the panel. Hovering uses the host tooltip to show the state in words:

| State | Tooltip |
| --- | --- |
| Not running | `Kestrel is not running. It is not holding the microphone.` |
| Starting | `Starting. Microphone may be in use.` |
| Status unavailable | `Status unavailable. Microphone use unknown.` |
| Idle | `Kestrel: idle. Microphone in use. Waiting for you to speak.` |
| Listening | `Kestrel: listening to you. Microphone in use.` |
| Thinking | `Kestrel: thinking about your message. Microphone in use.` |
| Speaking | `Kestrel: speaking. Microphone in use.` |
| Trouble | `Kestrel: brain trouble. A reply could not be completed. Microphone in use.` |

### Conversation panel

A floating window of fixed size, 448 by 640, which the owner moves with `Super` and a left drag.

- **Placement.** First opening uses the focused monitor's bottom-right work area, accounting for reserved space, outer gaps and the native border. Later openings retain the actual dragged position within the compositor configuration lifetime. When the monitor or its work area changes, clamp a position only if it would leave the panel off screen. Preserve a deliberately partly off-screen drag when that work area has not changed. Compositor configuration reload resets placement; cross-reload or restart storage is not provided.
- **Opening and closing.** The indicator and `Super + F12` toggle the panel. Opening focuses its square `Close conversation` button, at least 33 by 33. That button, `Escape`, native window close or either toggle hides the panel and returns compositor focus to the prior window. The conversation stays in the voice service while it runs.
- **Header.** The title `Kestrel` in bold title text, with the close button at the right. Beneath it, the status row: the three marks for the current state, the label gap, then the status sentence. Beneath that, the hint `Move: Super + left drag` in caption text, wrapping within the header width.
- **Header marks.** The same drawing, sizes and motion as the bar, in popups text, with resting states at 0.6 opacity and trouble in bar active. They are decorative: no click, tooltip or keyboard focus, and hidden from assistive technology, because the sentence beside them says the state.
- **Conversation.** Kestrel's turns sit flush left under a bold `Kestrel` label in accent. The owner's turns are inset by 32 under a bold `You` label in popups text. The reply in progress shows `Thinking` or `Speaking` beside its label. All transcript text is plain text, wraps long words and scrolls vertically. Auto-follow only while already at the bottom; updates never jump away from earlier text being read. This read-only panel has no composer, send control or active links.
- **Empty and failure copy.** A healthy empty feed says `Say something. Kestrel replies after you.` A stale, malformed or disconnected feed clears the transcript and says `Conversation unavailable. Reopen the panel.` An oversized conversation says `Conversation is too large to display. Restart Kestrel to begin a new conversation.` Interrupted or failed rows end with an accent warning triangle and `Reply interrupted.` or `Reply could not be completed.` These states make no microphone claim.
- **Placement failure.** `Panel position could not be confirmed. Try closing and reopening it.` appears in the panel and the indicator's accessible name and native tooltip. An initial configuration check with errors instead shows `Hyprland has configuration errors. Run hyprctl configerrors, fix the errors, then reopen the panel.` The panel stays hidden until placement and clean configuration are confirmed. A new failure actively exposes that tooltip even when the panel is hidden and the pointer is elsewhere; a confirmed opening clears it unless the pointer is still hovering. Cleanup failures preserve the original advisory. Neither message changes microphone status. No native errors or window metadata are shown.
- **Focus and keys.** Focus uses a 2-pixel accent ring. `Tab` and `Shift + Tab` cycle between close and transcript. `Enter` and `Space` activate close. The transcript accepts arrows, `PageUp`, `PageDown`, `Home` and `End` to scroll; `Escape` hides the panel from either focus target. The transcript has a document role, turns have speaker-named static text roles, and a turn that becomes complete, interrupted or failed while the panel is open is announced politely once, never per token. Opening the panel, reconnecting, a new session and updates while hidden read existing history silently.

| State | Status sentence |
| --- | --- |
| Not running | `Not running. Microphone released by Kestrel.` |
| Starting | `Starting. Microphone may be in use.` |
| Status unavailable | `Status unavailable. Microphone use unknown.` |
| Idle | `Idle. Microphone in use.` |
| Listening | `Listening. Microphone in use.` |
| Thinking | `Thinking. Microphone in use.` |
| Speaking | `Speaking. Microphone in use.` |
| Trouble | `Brain trouble. Microphone in use.` |

Every pointer target is at least 24 by 24.

### Native accessibility and verification

The panel follows the native roles, keyboard order, initial focus and close behavior above. Use [Qt accessibility metadata](https://doc.qt.io/qt-6/accessible-qtquick.html) compatible with the installed Qt version, which the plan must verify. Decorative header marks remain excluded from assistive technology; the adjacent status sentence carries their meaning.

The indicator queries `hyprctl -j getoption animations:enabled` initially and every five seconds, with at most one outstanding query, a one-second watchdog and a 4096-character output limit. Only a successful, fresh object naming `animations:enabled` with boolean `bool: true` enables loops. False, absent, malformed, failed or ten-second-stale results preserve the still shapes above. The host-injected singleton owns the watcher and preference query across monitors.

During the native visual drive, verify keyboard and assistive-technology interaction, pointer target dimensions at the actual display scale, enlarged text and long content. Check that text and controls remain readable and usable. Measure rendered text and control contrast after theme opacity and background composition; inherited theme roles alone are not evidence of sufficient contrast. Record unavailable observations as limitations. Follow the resume skill's visual and accessibility review requirements; browser scans and screenshots alone do not prove native accessibility.

Displayed microphone and status claims require supporting runtime evidence, including evidence for microphone release. Missing status does not establish release. Any new meaning or wording for unavailable status requires an owner decision before implementation.
