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
- Resting marks use their text role at 0.6 opacity. Conversation bubbles add only these derived opaque roles: Kestrel tint is ink at 10% over the flattened popup background; owner wash is accent at 20% over that background; scroll-edge rule is ink at 20% over it. Flatten the resolved popup role with the host fallback and force its alpha to 1 before composition. Both bubbles use popup ink text, never accent-filled messages or derived state colours. The microphone question badge and Send on-accent glyph use this flat background. The composer uses the Kestrel tint; disabled Send is transparent with a rule-colour outline and ink at 0.6 opacity. Reference palettes for verification are Tokyo Night background `#1a1b26`, ink `#a9b1d6`, accent `#7aa2f7`, and Latte `#eff1f5`, `#4c4f69`, `#1e66f5`; production remains bound to host roles.
- State is never carried by colour alone. Bar active marks trouble only; every other indicator state uses bar text.
- The desktop supplies the window border, the font family (`monospace`) and the window opacity. The panel draws no border of its own.

### Type and spacing

Dimensions and type sizes use Qt logical (device-independent) pixels at Omarchy base size 14, following [Qt's scaling model](https://doc.qt.io/qt-6/highdpi.html). This includes panel geometry and pointer targets. For the target-size audit, use Qt’s density-independent logical pixel as the native equivalent of a CSS (Cascading Style Sheets) reference pixel, following [World Wide Web Consortium guidance](https://www.w3.org/TR/wcag2ict-22/), and verify the rendered target at the actual display scale.

| Token | Value |
| --- | --- |
| Caption text | 12 |
| Body text | 14 |
| Title text | 16 |
| Title / body / caption line heights | 20 / 21 / 16 |
| Padding | 16 |
| In-panel tooltip maximum width / window edge margin | Panel width minus 32 / 16 |
| Label gap | 5 |
| Control gap | 9 |
| Control height | 33 |
| Focus stroke | 2 |
| Bar height | 30 |
| Panel width | 448 |
| Panel height | 640 |
| Header top / bottom padding | 14 / 12 |
| Header columns | flexible / close, gap 9 |
| Close radius / focus offset | 8 / 2 outside |
| Microphone slot side | `max(24, body line height + caption text / 2)` |
| Microphone glyph / question badge text | Body / caption size |
| Question badge diameter | Caption line height |
| Bubble padding, vertical / horizontal | 8 / 12 |
| Bubble radius / pointing corner | 14 / 4 |
| Bubble minimum / maximum width | 44 / feed width minus 56 |
| Same-speaker / different-speaker gap | 4 / 14, zero before first turn |
| Live tail | feed mark slot 40, state word, right inset 10; height max(26, caption line height + 10) |
| Listening ghost | 40 by 26 |
| Tail radii, top-left / top-right / bottom-right / bottom-left | 0 / 0 / 10 / 4 attached, with top-right 10 where the tail is wider than its bubble; 10 / 10 / 10 / 4 alone |
| Listening ghost outer radii | 10 / 10 / 4 / 10 |
| Listening ghost stroke / dash / gap | 1.5 / 4 / 3 |
| Listening ghost path inset / radius adjustment | 0.75 / subtract 0.75 |
| Feed square or bar width / gap / thinking lift | 4 / 4 / 6 |
| Feed speaking heights / still heights | 5 through 16 / 8, 16, 11 |
| Feed thinking step / speaking periods | 280 ms / 420, 520, 610 ms |
| Terminal caption gap / inset | 4 / 2 |
| Failure mark slot / label gap | 25 wide by caption line height / 5 |
| Scroll-edge rule | 1 |
| Close control minimum side | 33 |
| Composer footer top / side / bottom padding | 10 / 16 / 12 |
| Composer notice gap / row gap | 6 / 9 |
| Composer radius / vertical / horizontal padding | 10 / 9 / 12 |
| Composer minimum height / native visual line cap | 40 / 5 |
| Send minimum side / radius | 40 / 10 |
| Disabled Send outline / ink opacity | 1.5 / 0.6 |
| Send glyph padding, vertical / horizontal | 9 / 12 |
| Field / transcript focus | 2 inset |
| Button focus offset / stroke | 2 outside / 2 |

Panel text follows the host's text size. The panel's text scale is the host `Style.fontScale` multiplied by 12/14, so host base size 14 gives exactly the token values above and base size 28 doubles them; a scale that is not a finite positive number falls back to 1. Caption, body and title text, all three line heights and the transcript's one-line scroll step are each the token value times the scale, rounded to the nearest pixel and at least 1. The close control stays square, each side the larger of 33 and its glyph's larger rendered extent plus 4. The header takes the taller of its title/status column and close control. Panel size, edge padding, gaps, bubble geometry, focus stroke and marks stay fixed: text wraps within them and the transcript scrolls in the remaining space. Content must also fit a 320-wide test view.

### The three marks

The indicator's slot is 25 wide and the full bar height. Listening uses the Inflow rings and dot in both the indicator and the panel listening ghost. The other states use three marks, each 3 wide with 3 between them, standing on a common baseline 9 above the bottom of the bar. The shape names the state.

| State | Shape | Motion |
| --- | --- | --- |
| Not running | One unbroken bar, 15 wide and 2 high, at 0.6 opacity | None |
| Inactive | Three outlined 3 by 3 squares with 1-pixel strokes, at 0.6 opacity | None |
| Starting | Three outlined 3 by 3 squares with 1-pixel strokes, at full bar-text opacity | None |
| Status unavailable | Three 3 by 3 squares raised left-to-right by 0, 3 and 6, at full bar-text opacity | None |
| Idle | Three squares, 3 high, at 0.6 opacity | None |
| Listening | Inflow: two rings gathering toward a central dot | One linear 1600 ms phase drives the rings and dot pulse |
| Thinking | Three squares, one raised by 5 | The raised square steps to the next position every 280 ms |
| Speaking | Three bars of unequal height | Each bar eases between 4 and 12 high, on periods of 420, 520 and 610 ms |
| Trouble | Two squares and an exclamation mark, a 7 high bar above a square, in bar active | None |

Inflow occupies the same 25 by 30 slot, centred at (12.5, 15), with maximum outer diameter 15. It identifies listening, never measured sound level.

| Listening token | Value |
| --- | --- |
| Dot | Diameter 3, opaque inherited ink, circular and scaled about its centre; maximum diameter 3.3 |
| Rings | Two transparent circles in inherited ink, constant stroke 1.5; path radius `(D - 1.5) / 2` for outer diameter `D` |
| Driver | Linear phase `p` from 0 to 1, repeating every 1600 ms |
| Ring phases | `q = p modulo 1` and `q = (p + 0.5) modulo 1` |
| Incoming, `q <= 0.7` | `D = 15 - 10(q / 0.7)^2`; opacity `(q / 0.7)^2` |
| Disappearing, `q > 0.7` | `D = 5 - 2((q - 0.7) / 0.3)^2`; opacity `1 - (q - 0.7) / 0.3` |
| Dot pulse | `u = (1600p) modulo 800` milliseconds; scale `1 + 0.1 sin(pi u / 120)` for `u < 120`, otherwise 1 |
| Reduced motion | Unscaled dot and first ring diameter 9 at opacity 0.6; second ring hidden; no running listening animation |

Draw the rings with native QtQuick.Shapes `ShapePath` and `PathAngleArc`, using a 360-degree sweep so the 1.5 stroke stays real-valued. Prefer `Shape.CurveRenderer` for smooth curves and native antialiasing, retaining Qt's native renderer fallback. Draw the dot as a round Rectangle. Leaving listening stops its loop and resets phase zero; re-entry or re-enabling motion starts from phase zero. Other states retain their geometry and animations.

Where the desktop asks for reduced motion, nothing loops: listening uses the still Inflow form above, thinking shows the middle square raised and still, and speaking shows bars 6, 12 and 8 high and still.

The status indicator is an accessible button named `Open panel` or `Close panel`, followed by the status sentence and any placement advisory. Its 25 by 30 slot is the click target. Its marks are decorative and excluded from assistive technology. Pressing it toggles the panel. Hovering uses the host tooltip to show the state in words:

| State | Tooltip |
| --- | --- |
| Not running | `Kestrel is not running. It is not holding the microphone.` |
| Inactive | `Voice off. Microphone in use. Press Super + Shift + K to start.` |
| Starting | `Starting. Microphone may be in use.` |
| Status unavailable | `Status unavailable. Microphone use unknown.` |
| Idle | `Kestrel: waiting for you to speak. Microphone in use.` |
| Listening | `Kestrel: listening to you. Microphone in use.` |
| Thinking | `Kestrel: thinking about your message. Microphone in use.` |
| Speaking | `Kestrel: speaking. Microphone in use.` |
| Trouble | `Kestrel needs attention. Microphone in use.` |

### Conversation panel

A floating window of fixed size, 448 by 640, which the owner moves with `Super` and a left drag.

- **Placement.** First opening uses the focused monitor's bottom-right work area, accounting for reserved space, outer gaps and the native border. Later openings retain the actual dragged position within the compositor configuration lifetime. When the monitor or its work area changes, clamp a position only if it would leave the panel off screen. Preserve a deliberately partly off-screen drag when that work area has not changed. Compositor configuration reload resets placement; cross-reload or restart storage is not provided.
- **Opening and closing.** The indicator and `Super + F12` toggle the panel. Opening focuses the composer at the draft end. The square `Close panel` button remains at least 33 by 33. That button, `Escape`, native window close or either toggle hides the panel and returns compositor focus to the prior window. These actions only hide or show the panel. `Super + Shift + K` starts or dismisses the voice conversation.
- **Header.** A flexible title/status column and close button use the header tokens; the header has no state mark. Bold `Kestrel` sits above a passive microphone icon and wrapped caption-sized short label: `Not running`, `Voice off · Mic in use`, `Starting`, `Unavailable`, `Waiting`, `Listening`, `Thinking`, `Speaking`, or `Attention`; unknown keys use `Unavailable`. In `Voice off · Mic in use` every space except the one after the middle dot is a no-break space, so enlarged text wraps only after the dot. `Attention` uses trouble ink and every other label popup ink; the word carries the meaning. The full status sentence below is the static status group's accessible name and microphone target's accessible description and native tooltip, never visible body text. `Move: Super + left drag` belongs only to the header's accessible description and native tooltip. Its hover excludes close and the microphone target. Placement advisories remain visible in a separate wrapped band below the header, separated by 9.
- **Header microphone.** The passive microphone uses host glyph `󰍬` for verified in-use states (inactive, idle, listening, thinking, speaking, trouble), `󰍭` only for verified not-running, and `󰍬` with a separate top-right `?` badge for starting or unavailable/unknown. Never derive microphone use from a reply. The microphone is not a button or keyboard stop. Panel injects native `OpticalGlyph` and `PanelToolTip` components from `qs.Ui` into the host-free Conversation. Glyph text, size and colour stay reactively bound; native tooltips retain the host's 400 ms delay, typography, colours, internal padding and border, bind parent/text/visibility to their hover target, and are destroyed with their Loader. In-panel tooltips hug their text up to the maximum width token and wrap without elision. They use Qt's in-window popup placement with the window edge margin token; Qt owns positioning and content-driven height. No passive click handler consumes move or scroll input.
- **Conversation.** Quiet native monospace bubbles align Kestrel left and owner right, hug text within the width tokens and use the tint/wash roles. No visible speaker labels or read receipts; accessible names retain speaker prefixes. Text remains plain, preserves line breaks, wraps long words and scrolls vertically. Bubble width is `min(feed width - 56, max(44, text implicit width + 24, provenance width + 24))`. Body width is bubble width minus 24; height is text implicit height plus 16, adding a caption line and 4 gap only for finalized owner provenance. Kestrel bottom-left corner is 4 and consecutive Kestrel top-left is also 4, mirrored for owner. Only finalized spoken owner turns carry a caption-sized native microphone at bottom-right, tooltip and accessible description `Spoken message`. Typed owner turns omit that caption and use accessible description `Typed message`. Short feeds sit at the bottom; clipped top/bottom edges alone show the 1-pixel rule. Auto-follow only while already at the bottom; updates never jump away from earlier text being read. All entrances are still, including new turns and replayed history. The transcript remains read-only with no active links.
- **Live edge.** Only the final Kestrel thinking/speaking row in a valid conversation owns the tint tail, attached flush below its left edge; its bubble bottom-left becomes 0. With no text there is only the standalone tail, never an empty placeholder bubble. The tail holds the feed marks in their larger geometry in its 40-wide slot, followed by the caption-sized word `Thinking` or `Speaking` in popup ink, vertically centred; the word is decorative and shows in both moving and still forms; still thinking raises the middle square. Only `motionEnabled && announcementsEnabled` permits their loops. Listening shows a final right-aligned, unfilled dashed ghost with centered default-size Inflow, only while the verified current state is listening and the feed is valid; its accessible name is `Listening`. Native ShapePath dash lengths are expressed in stroke-width units, `[4/1.5, 3/1.5]`, with a flat cap and the inset/radii above. Hide only the healthy empty advisory while this ghost is present. Never fabricate a transcript or announcement, word alignment, speculative text or timed sample replies.
- **Empty and failure copy.** A healthy empty feed says only what works in the current state: `Press Super + Shift + K to talk, or type below.` while voice is off, `Say something, or type below.` while voice is on, `Start Kestrel to talk or type.` while not running, `Kestrel is starting. Wait to talk or type.` while starting, `Voice status unknown.` while status is unavailable, and `Kestrel needs attention. Check the service log.` in trouble. Empty-feed messages are centred in the transcript. A stale, malformed or disconnected feed clears the transcript and says `Conversation unavailable. Reopen the panel.` An oversized conversation says `Conversation is too large to display. Restart Kestrel to begin a new conversation.` Terminal empty rows remain visible with their notice. `Reply interrupted.` has no glyph; failure uses a still trouble mark in trouble ink beside `Reply could not be completed.`, its ink centred on the first caption line of the notice; a spoken advisory stays the text of its reply bubble. Notices use caption size and line height, the terminal gap/inset above, and reserve the failure slot plus label gap only when its glyph exists. These states make no microphone claim.
- **Placement failure.** `Panel position could not be confirmed. Try closing and reopening it.` appears in the panel and the indicator's accessible name and native tooltip. An initial configuration check with errors instead shows `Hyprland has configuration errors. Run hyprctl configerrors, fix the errors, then reopen the panel.` The panel stays hidden until placement and clean configuration are confirmed. A new failure actively exposes that tooltip even when the panel is hidden and the pointer is elsewhere; a confirmed opening clears it unless the pointer is still hovering. Cleanup failures preserve the original advisory. Neither message changes microphone status. No native errors or window metadata are shown.
- **Composer.** A native plain-text `TextArea` inside `ScrollView` wraps actual visual lines, with fixed tinted background and native vertical scrolling after five lines. Field height is `max(40, min(contentHeight, fiveLineExtent) + 18)`, where fiveLineExtent is five times native `contentHeight / lineCount`; the empty native editor supplies one line, and a not-yet-laid-out editor stays at 40. Transcript line-height tokens never determine editor height. At installed Qt's normal font, five lines measure 113 high at body14 and 203 at body28; these are verification examples, not font constants. The footer reduces the transcript viewport, preserves reading position and follows only from the bottom. Placeholder `Message Kestrel` is italic ink, while entered text stays upright. A decorative plain Text overlay may style the placeholder independently and is excluded from accessibility. Bottom-aligned Send uses a native upward arrow, accent fill and flat-background on-accent ink, grows for its glyph plus padding and is named `Send message`. Disabled Send uses the outline/opacity tokens.
- **Draft and submission.** Drafts and pending results survive hide/show only in the mounted component; reload/destruction loses the draft and never resends. Editing remains available during a submission. Only matching confirmed acceptance clears an unchanged edit revision through native `clear()`, and never during input-method composition. Pending caption is `Sending…`; invalid is `Message not sent. Shorten it or remove unsupported control characters.`; busy is `Message not accepted. Kestrel is finishing a change. Try Send again.`; unavailable is `Message not sent. Kestrel is unavailable. Check the service, then try Send.`; uncertain is `Delivery could not be confirmed. Check the conversation before sending again; an action may already have run.` A result owns the caption until the next edit/send. With a nonblank draft and a current thinking/speaking reply, otherwise show `Sending stops the current reply.` Changed visible captions announce politely once; hidden results and reopening are silent. No raw errors, permanent key hints or character counter.
- **Focus and keys.** Focus uses the accent ring tokens, inset within field/transcript and outside buttons. `Tab` cycles composer, enabled Send, close, transcript; `Shift + Tab` reverses and disabled Send is skipped. Native `KeyNavigation.BeforeItem` keeps Tab out of the draft. `Enter`/`Return` sends valid nonblank text once, suppressing autorepeat; `Shift + Enter` inserts a newline. Input-method composing owns Enter and disables Send. Other editing, selection, copy/paste and navigation remain native. `PageUp`/`PageDown` scroll the transcript from the editor. The transcript accepts arrows, `PageUp`, `PageDown`, `Home` and `End`; `Escape` hides from every focus stop. A disabled focused Send moves synchronously to the editor; delayed results never steal focus outside composer/Send. Hide preserves text, selection and editor scroll; reopening deliberately places the cursor at draft end. The transcript has a document role, turns have speaker-named static text roles, and a turn that becomes complete, interrupted or failed while open is announced politely once, never per token. Opening, reconnecting, a new session and hidden updates read history silently.

| State | Status sentence |
| --- | --- |
| Not running | `Not running. Microphone released by Kestrel.` |
| Inactive | `Voice off. Microphone in use. Press Super + Shift + K to start.` |
| Starting | `Starting. Microphone may be in use.` |
| Status unavailable | `Status unavailable. Microphone use unknown.` |
| Idle | `Waiting. Microphone in use.` |
| Listening | `Listening. Microphone in use.` |
| Thinking | `Thinking. Microphone in use.` |
| Speaking | `Speaking. Microphone in use.` |
| Trouble | `Kestrel needs attention. Microphone in use.` |

Every pointer target is at least 24 by 24.

### Native accessibility and verification

The panel follows the native roles, keyboard order, initial focus and close behavior above. Use [Qt accessibility metadata](https://doc.qt.io/qt-6/accessible-qtquick.html) compatible with the installed Qt version, which the plan must verify. Decorative marks remain excluded from assistive technology; the static status group's accessible name and native tooltip carry the complete status meaning.

The indicator queries `hyprctl -j getoption animations:enabled` initially and every five seconds, with at most one outstanding query, a one-second watchdog and a 4096-character output limit. Only a successful, fresh object naming `animations:enabled` with boolean `bool: true` enables loops. False, absent, malformed, failed or ten-second-stale results preserve the still shapes above. The host-injected singleton owns the watcher and preference query across monitors.

During the native visual drive, verify keyboard and assistive-technology interaction, pointer target dimensions at the actual display scale, enlarged text and long content. Check that text and controls remain readable and usable. Measure rendered text and control contrast after theme opacity and background composition; inherited theme roles alone are not evidence of sufficient contrast. Record unavailable observations as limitations. Follow the resume skill's visual and accessibility review requirements; browser scans and screenshots alone do not prove native accessibility.

Displayed microphone and status claims require supporting runtime evidence, including evidence for microphone release. Missing status does not establish release. Any new meaning or wording for unavailable status requires an owner decision before implementation.
