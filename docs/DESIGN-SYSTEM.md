# Design system

The current conversation uses native laptop audio, operated as [README.md](../README.md) describes. It has no browser client. The desktop notification, native indicator and conversation panel patterns live below.

This manual owns visual controls, interaction and accessibility. Spoken behaviour and product meaning stay with [AGENTS.md](../AGENTS.md#product) and the operation manual.

Product discovery and drilling with the owner precede interface design or implementation. An approved interface plan must establish its tokens and patterns here before building, as [AGENTS.md](../AGENTS.md) and the resume skill require.

## Native audio failure notification

Use the installed desktop's native notification component, inheriting its color, typography, spacing and placement. Kestrel adds no theme tokens, layout, custom controls or desktop configuration.

| Property | Value |
| --- | --- |
| Application name | `Kestrel` |
| Summary | `Mute could not be confirmed`, `Unmute could not be confirmed` or `Volume could not be confirmed`, matching the failed action |
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
- On an opaque bar, faint resting marks use their text role at the faint opacity [The three marks](#the-three-marks) defines, over the flat bar background: the resolved bar background role with the host fallback, its alpha forced to 1. Conversation bubbles add only these derived opaque roles: Kestrel tint is ink at 10% over the flattened popup background; owner wash is accent at 20% over that background; scroll-edge rule is ink at 20% over it. Flatten the resolved popup role with the host fallback and force its alpha to 1 before composition. Both bubbles use popup ink text, never accent-filled messages or derived state colours. The voice button's question badge and the on-accent glyphs of Send and the active voice button use this flat background. The composer and the resting voice button use the Kestrel tint; disabled Send and voice button are transparent with a rule-colour outline and ink at 0.6 opacity. Reference palettes for verification are Tokyo Night background `#1a1b26`, ink `#a9b1d6`, accent `#7aa2f7`, and Latte `#eff1f5`, `#4c4f69`, `#1e66f5`; production remains bound to host roles.
- State is never carried by colour alone. Bar active marks trouble only. Every other indicator state uses bar text on an opaque bar and, on a transparent bar, the host's bar foreground (`barForeground`): the one colour the host gives every bar icon, chosen against the wallpaper's average across the whole bar. Each icon's contrast depends on the wallpaper behind it, so where that wallpaper is darker or lighter than the average the marks, like the host's own icons, can fall under 3 to 1.
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
| Voice glyph / question badge text | Body / caption size |
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
| Feed marks slot / first bar x / bar centre y | 40 by 26 / 10 / 13 |
| Feed marks scale | Every indicator length times 4/3: bar width 4, pitch 8, still heights 8 and 16 |
| Terminal caption gap / inset | 4 / 2 |
| Failure mark slot / label gap | 25 wide by caption line height / 5 |
| Scroll-edge rule | 1 |
| Transcript minimum height | Body line height plus 16, one bubble line |
| Close control minimum side | 33 |
| Composer footer top / side / bottom padding | 10 / 16 / 12 |
| Composer notice gap / row gap | 6 / 9 |
| Composer radius / vertical / horizontal padding | 10 / 9 / 12 |
| Composer minimum height / native visual line cap | 40 / 5 |
| Send and voice button minimum side / radius | 40 / 10 |
| Disabled Send and voice button outline / ink opacity | 1.5 / 0.6 |
| Send and voice glyph padding, vertical / horizontal | 9 / 12 |
| Field / transcript focus | 2 inset |
| Button focus offset / stroke | 2 outside / 2 |

Panel text follows the host's text size. The panel's text scale is the host `Style.fontScale` multiplied by 12/14, so host base size 14 gives exactly the token values above and base size 28 doubles them; a scale that is not a finite positive number falls back to 1. Caption, body and title text, all three line heights and the transcript's one-line scroll step are each the token value times the scale, rounded to the nearest pixel and at least 1. The close control stays square, each side the larger of 33 and its glyph's larger rendered extent plus 4. The header takes the taller of its title/status column and close control. Panel size, edge padding, gaps, bubble geometry, focus stroke and marks stay fixed: text wraps within them, and the advisory region and transcript scroll in the remaining space. Content must also fit a 320-wide test view.

### The three marks

The indicator's slot is 25 wide and the full bar height. Every state draws the same three vertical bars, each 3 wide at x 5, 11 and 17 and centred on y 15; a state sets their heights, fill, opacity and colour, and the shape names the state. Heights are indicator pixels, `i` numbers the bars 0 to 2 from the left, and each phase `p` runs linearly from 0 to 1.

| State | Still form, bar heights left to right | Motion |
| --- | --- | --- |
| Not running | 2, 2, 2, the first two widened to 6 so the three join into one 15 by 2 line, faint | None |
| Inactive | 6, 6, 6, outlined with 1-pixel strokes, faint | None |
| Starting | 6, 6, 6, outlined with 1-pixel strokes | None |
| Status unavailable | 4, 8, 12, rising | None |
| Idle | 6, 6, 6, faint | None |
| Slow start, voice off | 3, 3, 3, three 3 by 3 dots read as an ellipsis, outlined with 1-pixel strokes, faint | None |
| Slow start, voice on | 3, 3, 3, three 3 by 3 dots read as an ellipsis, faint | None |
| Listening | 12, 12, 12 | All three together, each `9 + 3 cos(2 pi p)` on one 1600 ms phase |
| Thinking | 6, 12, 6 | A ripple: bar `i` is `8 + 4 cos(2 pi (p + (1 - i) / 3))` on one 840 ms phase, so the crest moves one bar right every 280 ms |
| Speaking | 12, 6, 12 | Each bar on its own phase, repeating every 420, 520 and 610 ms: the outer bars `8 + 4 cos(2 pi p)`, the middle bar `9 - 3 cos(2 pi p)` |
| Trouble | 6, 6, then a 7 high bar raised 2.5 above a 3 by 3 dot whose top is 3 below centre: an exclamation mark, all in bar active | None |

Faint is the lowest opacity from 0.6 to 1, in steps of 0.01, at which the mark's ink over the flat background beneath it measures at least 3 to 1 against that background, the [non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) minimum. Each colour channel is taken one 8-bit step in the direction that brings the mark's luminance nearer the background's, because rendering can round that far. Where even full ink stays under 3 to 1, faint is full opacity and the form alone tells the state apart. The indicator's flat background is the bar background from [Colour](#colour); on a transparent bar the desktop shows through and cannot be measured, so faint is full opacity there and the form alone marks the state as quiet; a translucent bar background is measured as if opaque. On the reference palettes faint is 0.64 on Latte and 0.6 on Tokyo Night.

Any other value shows the status unavailable form. A form the table does not call outlined or faint is solid at full opacity in its ink. A moving state's still form is its motion at phase 0; the motion is added as its difference from that form, scaled by a weight that glides between 0 and 1, so motion fades in and out from the form on screen. The bars mark state, never measured sound level.

Every state change glides from the form on screen to the next in 180 ms with OutCubic easing: heights, the trouble lift and dot, the not-running join, outline fill, opacity, colour and the motion weights. A change during a glide starts the next glide from the current values. Leaving a moving state, or turning animations off, holds its phase; coming back resumes from the held phase while its weight glides in, so the motion never jumps. A newly shown mark appears in its form without a glide. The panel's live marks and listening ghost draw the same family at feed scale.

Where the desktop asks for reduced motion, nothing loops or glides: every state shows its still form and changes to the next at once. Turning animations off shows the current still form at once, mid-glide and mid-loop included.

The status indicator is an accessible button named `Open panel` or `Close panel`, followed by the status sentence and any placement advisory. Its 25 by 30 slot is the click target. Its marks are decorative and excluded from assistive technology. Pressing it toggles the panel. Hovering uses the host tooltip to show the state in words:

| State | Tooltip |
| --- | --- |
| Not running | `Kestrel is not running. It is not holding the microphone.` |
| Inactive | `Voice off. Microphone in use. Press Super + Shift + K to start.` |
| Starting | `Starting. Microphone may be in use.` |
| Status unavailable | `Status unavailable. Microphone use unknown.` |
| Idle | `Kestrel: waiting for you to speak. Microphone in use.` |
| Slow start, voice off | The Inactive tooltip, then `The brain was slow to start. Replies may take longer.` |
| Slow start, voice on | The Idle tooltip, then `The brain was slow to start. Replies may take longer.` |
| Listening | `Kestrel: listening to you. Microphone in use.` |
| Thinking | `Kestrel: thinking about your message. Microphone in use.` |
| Speaking | `Kestrel: speaking. Microphone in use.` |
| Trouble | `Kestrel needs attention. Microphone in use.` plus the cause's advisory from [Trouble advisories](#trouble-advisories) |

### Conversation panel

A floating window of fixed size, 448 by 640, which the owner moves with `Super` and a left drag.

- **Placement.** First opening uses the focused monitor's bottom-right work area, accounting for reserved space, outer gaps and the native border. Later openings retain the actual dragged position within the compositor configuration lifetime. When the monitor or its work area changes, clamp a position only if it would leave the panel off screen. Preserve a deliberately partly off-screen drag when that work area has not changed. Compositor configuration reload resets placement; cross-reload or restart storage is not provided.
- **Opening and closing.** The indicator and `Super + F12` toggle the panel. Opening focuses the composer at the draft end. The square `Close panel` button remains at least 33 by 33. That button, `Escape`, native window close or either toggle hides the panel and returns compositor focus to the prior window. These actions only hide or show the panel. `Super + Shift + K` and the voice button start or dismiss the voice conversation.
- **Header.** A flexible title/status column and close button use the header tokens; the header has no state mark. Bold `Kestrel` sits above a wrapped caption-sized short label: `Not running · Mic released`, `Voice off · Mic in use`, `Starting · Mic in use?`, `Unavailable · Mic in use?`, `Waiting · Mic in use`, `Listening · Mic in use`, `Thinking · Mic in use`, `Speaking · Mic in use`, or `Attention · Mic in use`; unknown keys use `Unavailable · Mic in use?`. In each label every space except the one after the middle dot is a no-break space, so enlarged text wraps only after the dot. `Attention · Mic in use` uses trouble ink and every other label popup ink; the word carries the meaning. The full status sentence below is the static status group's accessible name, accessible description and native tooltip, never visible body text. `Move: Super + left drag` belongs only to the header's accessible description and native tooltip. Its hover excludes close and the status group. One advisory region sits directly below the header, separated by the header Column's 9 gap: the trouble advisory, then any slow-start notice, then any placement advisory, each a wrapped body-text band in popup ink, 9 apart. The region is as tall as its bands but never leaves the transcript below its minimum height. When that clips it, it scrolls with the transcript's keys, its clipped edges alone show the 1-pixel rule, and it becomes a focus stop. Its accessible name is its full text.
- **Voice button.** A square button sits immediately left of Send, the composer row gap apart and bottom-aligned with it, using the Send size, radius, glyph padding and button focus tokens; the composer narrows and Send keeps its corner. Its form follows verified status only, never the command's reply: idle, listening, thinking or speaking shows the active form, accent fill with host glyph `󰍬` in the flat background, named `End voice conversation`; inactive or not running shows the resting form, Kestrel tint with `󰍮` in popup ink, named `Start voice conversation`; starting, trouble, unavailable or unknown status, and a press from the moment it is made until the first status update after its command ends, show the resting form with the question badge flush at its top-right, named `Start or end voice conversation`. Without a service it uses the disabled tokens with `󰍮` and no badge. Its accessible description is the full status sentence and its native tooltip is its name. A pointer press, `Space`, `Enter` or `Return` runs the same `control.py --toggle` request as `Super + Shift + K` once; focus, hover and Tab never press it, and a press while the previous press's command is still running is ignored. Refusal, a missing service or an unconfirmed reply attempts the shortcut's native notification; the panel adds no caption and never retries. State changes are still. Panel injects native `OpticalGlyph` and `PanelToolTip` components from `qs.Ui` into the host-free Conversation. Glyph text, size and colour stay reactively bound; native tooltips retain the host's 400 ms delay, typography, colours, internal padding and border, bind parent/text/visibility to their hover target, and are destroyed with their Loader. In-panel tooltips hug their text up to the maximum width token and wrap without elision. They use Qt's in-window popup placement with the window edge margin token; Qt owns positioning and content-driven height. No passive click handler consumes move or scroll input.
- **Conversation.** Quiet native monospace bubbles align Kestrel left and owner right, hug text within the width tokens and use the tint/wash roles. No visible speaker labels or read receipts; accessible names retain speaker prefixes. Text remains plain, preserves line breaks, wraps long words and scrolls vertically. Bubble width is `min(feed width - 56, max(44, text implicit width + 24, provenance width + 24))`. Body width is bubble width minus 24; height is text implicit height plus 16, adding a caption line and 4 gap only for finalized owner provenance. Kestrel bottom-left corner is 4 and consecutive Kestrel top-left is also 4, mirrored for owner. Only finalized spoken owner turns carry a caption-sized native microphone at bottom-right, tooltip and accessible description `Spoken message`. Typed owner turns omit that caption and use accessible description `Typed message`. Short feeds sit at the bottom; clipped top/bottom edges alone show the 1-pixel rule. Auto-follow only while already at the bottom; updates never jump away from earlier text being read. All entrances are still, including new turns and replayed history. The transcript remains read-only with no active links.
- **Live edge.** Only the final Kestrel thinking/speaking row in a valid conversation owns the tint tail, attached flush below its left edge; its bubble bottom-left becomes 0. With no text there is only the standalone tail, never an empty placeholder bubble. The tail holds the feed marks in their larger geometry in its 40-wide slot, followed by the caption-sized word `Thinking` or `Speaking` in popup ink, vertically centred; the word is decorative and shows in both moving and still forms; still thinking shows its tall middle bar. Only `motionEnabled && announcementsEnabled` permits their loops and glides. A row keeps its live marks while the accepted feed keeps its length, so thinking turning to speaking glides; a feed of another length rebuilds its rows, which enter still. Listening shows a final right-aligned, unfilled dashed ghost holding the listening marks at feed scale, centred, only while the verified current state is listening and the feed is valid; its accessible name is `Listening`. Native ShapePath dash lengths are expressed in stroke-width units, `[4/1.5, 3/1.5]`, with a flat cap and the inset/radii above. Hide only the healthy empty advisory while this ghost is present. Never fabricate a transcript or announcement, word alignment, speculative text or timed sample replies.
- **Empty and failure copy.** A healthy empty feed says only what works in the current state: `Press Super + Shift + K to talk, or type below.` while voice is off, `Say something, or type below.` while voice is on, `Start Kestrel to talk or type.` while not running, `Kestrel is starting. Wait to talk or type.` while starting, `Voice status unknown.` while status is unavailable, and `Kestrel needs attention. Check the service log.` in trouble. Empty-feed messages are centred in the transcript. A stale, malformed or disconnected feed clears the transcript and says `Conversation unavailable. Reopen the panel.` An oversized conversation says `Conversation is too large to display. Restart Kestrel to begin a new conversation.` Terminal empty rows remain visible with their notice. `Reply interrupted.` has no glyph; failure uses a still trouble mark in trouble ink beside `Reply could not be completed.`, its ink centred on the first caption line of the notice; a spoken advisory stays the text of its reply bubble. Notices use caption size and line height, the terminal gap/inset above, and reserve the failure slot plus label gap only when its glyph exists. These states make no microphone claim.
- **Placement failure.** `Panel position could not be confirmed. Try closing and reopening it.` appears in the panel and the indicator's accessible name and native tooltip. An initial configuration check with errors instead shows `Hyprland has configuration errors. Run hyprctl configerrors, fix the errors, then reopen the panel.` The panel stays hidden until placement and clean configuration are confirmed. A new failure actively exposes that tooltip even when the panel is hidden and the pointer is elsewhere; a confirmed opening clears it unless the pointer is still hovering. Cleanup failures preserve the original advisory. Neither message changes microphone status. No native errors or window metadata are shown.
- **Composer.** A native plain-text `TextArea` inside `ScrollView` wraps actual visual lines, with fixed tinted background and native vertical scrolling after five lines. Field height is `max(40, min(contentHeight, fiveLineExtent) + 18)`, where fiveLineExtent is five times native `contentHeight / lineCount`; the empty native editor supplies one line, and a not-yet-laid-out editor stays at 40. Transcript line-height tokens never determine editor height. At installed Qt's normal font, five lines measure 113 high at body14 and 203 at body28; these are verification examples, not font constants. The footer reduces the transcript viewport, preserves reading position and follows only from the bottom. Placeholder `Message Kestrel` is italic ink, while entered text stays upright. A decorative plain Text overlay may style the placeholder independently and is excluded from accessibility. Bottom-aligned Send uses a native upward arrow, accent fill and flat-background on-accent ink, grows for its glyph plus padding and is named `Send message`. Disabled Send uses the outline/opacity tokens.
- **Draft and submission.** Drafts and pending results survive hide/show only in the mounted component; reload/destruction loses the draft and never resends. Editing remains available during a submission. Only matching confirmed acceptance clears an unchanged edit revision through native `clear()`, and never during input-method composition. Pending caption is `Sending…`; invalid is `Message not sent. Shorten it or remove unsupported control characters.`; busy is `Message not accepted. Kestrel is finishing a change. Try Send again.`; unavailable is `Message not sent. Kestrel is unavailable. Check the service, then try Send.`; uncertain is `Delivery could not be confirmed. Check the conversation before sending again; an action may already have run.` A result owns the caption until the next edit/send. With a nonblank draft and a current thinking/speaking reply, otherwise show `Sending stops the current reply.` Changed visible captions announce politely once; hidden results and reopening are silent. No raw errors, permanent key hints or character counter.
- **Focus and keys.** Focus uses the accent ring tokens, inset within field/transcript and outside buttons. `Tab` cycles composer, voice button, enabled Send, close, the advisory region while clipped, transcript; `Shift + Tab` reverses, skipping disabled Send, a disabled voice button and an unclipped region. Native `KeyNavigation.BeforeItem` keeps Tab out of the draft. `Enter`/`Return` sends valid nonblank text once, suppressing autorepeat; `Shift + Enter` inserts a newline. `Space`, `Enter` or `Return` presses a focused voice button once, suppressing autorepeat. Input-method composing owns Enter and disables Send. Other editing, selection, copy/paste and navigation remain native. `PageUp`/`PageDown` scroll the transcript from the editor. The transcript and a clipped advisory region accept arrows, `PageUp`, `PageDown`, `Home` and `End`; `Escape` hides from every focus stop. A focused advisory region that stops clipping moves focus synchronously to the transcript. A disabled focused Send moves synchronously to the editor; delayed results never steal focus outside composer/Send. Hide preserves text, selection and editor scroll; reopening deliberately places the cursor at draft end. The transcript has a document role, turns have speaker-named static text roles, and a turn that becomes complete, interrupted or failed while open is announced politely once, never per token. Opening, reconnecting, a new session and hidden updates read history silently.

| State | Status sentence |
| --- | --- |
| Not running | `Not running. Microphone released by Kestrel.` |
| Inactive | `Voice off. Microphone in use. Press Super + Shift + K to start.` |
| Starting | `Starting. Microphone may be in use.` |
| Status unavailable | `Status unavailable. Microphone use unknown.` |
| Idle | `Waiting. Microphone in use.` |
| Slow start, voice off | The Inactive sentence, then `The brain was slow to start. Replies may take longer.` |
| Slow start, voice on | The Idle sentence, then `The brain was slow to start. Replies may take longer.` |
| Listening | `Listening. Microphone in use.` |
| Thinking | `Thinking. Microphone in use.` |
| Speaking | `Speaking. Microphone in use.` |
| Trouble | `Kestrel needs attention. Microphone in use.` plus the cause's advisory from [Trouble advisories](#trouble-advisories) |

Every pointer target is at least 24 by 24.

### Trouble advisories

In trouble, the status snapshot carries one of these wire letters, and the panel band and tooltip show its advisory. An advisory names a cause only when the service verified that cause; otherwise it says the cause is unknown.

| Wire | State | Advisory |
| --- | --- | --- |
| B | `trouble` | `Cause unknown. Check the service log, then restart Kestrel.` |
| M | `trouble-microphone` | `Microphone capture failed. Restart Kestrel.` |
| P | `trouble-playback` | `Audio playback failed. Restart Kestrel.` |
| R | `trouble-recognition` | `Speech recognition failed. Restart Kestrel.` |
| V | `trouble-voice` | `Voice generation failed. Restart Kestrel.` |
| E | `trouble-engine` | `Kestrel's engine is unavailable. Restart Kestrel.` |
| G | `trouble-engine-missing` | `Kestrel's engine is missing, has changed or couldn't be checked. Reinstall it as the manual describes, then restart Kestrel.` |
| O | `trouble-notes` | `Local notes are unavailable or unsafe. Check note ownership, permissions, encoding and size, then restart Kestrel.` |
| H | `trouble-handover` | `A typed message could not reach the conversation. Restart Kestrel.` |

Two more wire letters are not trouble. W is voice off and Y is waiting, each after the brain was slow to start: the state, header label, voice button and empty-feed copy are those of the Inactive or Idle state, and the tooltip, the status sentence and its accessible names and the panel's advisory region add `The brain was slow to start. Replies may take longer.` as a body-text band in popup ink between the trouble advisory and the placement advisory. The notice carries no restart advice and no trouble ink, and the indicator shows the Slow start mark. Any other letter clears it.

### Native accessibility and verification

The panel follows the native roles, keyboard order, initial focus and close behavior above. Use [Qt accessibility metadata](https://doc.qt.io/qt-6/accessible-qtquick.html) compatible with the installed Qt version, which the plan must verify. Decorative marks remain excluded from assistive technology; the static status group's accessible name and native tooltip carry the complete status meaning.

The indicator queries `hyprctl -j getoption animations:enabled` initially and every five seconds, with at most one outstanding query, a one-second watchdog and a 4096-character output limit. Only a successful, fresh object naming `animations:enabled` with boolean `bool: true` enables loops. False, absent, malformed, failed or ten-second-stale results preserve the still shapes above. The host-injected singleton owns the watcher and preference query across monitors.

During the native visual drive, verify keyboard and assistive-technology interaction, pointer target dimensions at the actual display scale, enlarged text and long content. Check that text and controls remain readable and usable. Measure rendered text and control contrast after theme opacity and background composition; inherited theme roles alone are not evidence of sufficient contrast. Record unavailable observations as limitations. Follow the resume skill's visual and accessibility review requirements; browser scans and screenshots alone do not prove native accessibility.

Displayed microphone and status claims require supporting runtime evidence, including evidence for microphone release. Missing status does not establish release. Any new meaning or wording for unavailable status requires an owner decision before implementation.
