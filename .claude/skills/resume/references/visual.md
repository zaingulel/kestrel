# Visual work

This file is part of the `resume` skill: a section number or quoted heading in it names a section of
[its SKILL.md](../SKILL.md).

## Visual direction

- A plan for a change to how the interface looks, the architect's or the session's own short plan, is written with the
  vendored `frontend-design` skill. The planner reads `.agents/skills/frontend-design/SKILL.md` beside
  `docs/DESIGN-SYSTEM.md` and writes the visual direction into the plan under the heading `Visual direction`: every
  choice the change makes about colour, type and layout, and the principles that make the result specific to this
  product, each settled so that a builder carries it out without choosing. That section goes unchanged into the handoff
  of every builder whose slice changes the look, and is saved as **The saved records** below says. Where the skill and
  the design system disagree, neither wins by default, and the skill's own rule that the brief wins does not settle it:
  the owner gets a plain-language decision saying what each asks for and what choosing each would change, and the
  direction is written only after that decision and records it. A decision for the skill is planned as an amendment to
  the design system in the same change, so the build and the review are judged against the design system as amended. A
  value or pattern the design system merely lacks is no disagreement. The `explorer`, `oracle`, `plan-reviewer` and
  `security-reviewer` seats do not read the skill.

## Driving visual work and the accessibility audit

- Drive visual work as the Conventions table's `visual verification` row says, and display the screenshot inline
  in chat. No push authorisation is requested without it. Use representative views to demonstrate the changed
  interaction and its relevant visual risks, with at most ten screenshots total per pull request and fewer when
  sufficient. Reuse captures from required verification; do not rerun tests solely to collect screenshots. Visual
  verification coverage does not require an image for every screen, state, language or viewport.
- **Attaching screenshots.** Every screenshot the Evidence shows is attached to the pull request, unasked. **Saved
  write-up** in [review-and-push.md](review-and-push.md) saves each as `screenshot-<k>.<ext>` in the review folder. The
  body references each as a Markdown image whose alt text is `screenshot-<k> <hash>` and whose target is
  `./screenshot-<k>.<ext>`, `<hash>` being what
  `git hash-object --no-filters screenshot-<k>.<ext>` prints in that folder. Once the pull request is open, run from
  the review folder, for each screenshot, `gh pr edit <number> --attach './screenshot-<k>.<ext>#screenshot-<k> <hash>'`.
  GitHub uploads the file and rewrites the body's reference to the uploaded image, keeping its alt text. A screenshot
  replaced after it was attached carries a new hash, so its reference is rewritten with that hash and it is attached
  again. Work merging on its evidence merges
  only with every screenshot attached this way, as [merge-on-evidence.md](merge-on-evidence.md) says.
- Visual work also gets an accessibility audit, in the same drive. Read the vendored
  `.agents/skills/accessibility-review/SKILL.md` and apply it to each view the drive opens, as that view runs. The
  running view is the input: the skill's usage lines, its note about connectors and its section for connected tools
  are not followed, and a finding becomes a card only as this bullet says.
  - **Measured, never assumed.** A contrast ratio, a target's size, a focus order or an accessible name is taken
    from the running view, never read from the source or estimated. A step the skill lists that the drive cannot
    make, such as an automated scan or how a screen reader announces a control, is reported as not run, never as a
    pass.
  - **Target size.** The audit holds a pointer target to at least 24 by 24 CSS pixels, the measure of Success
    Criterion 2.5.8, Target Size (Minimum), level AA, of the Web Content Accessibility Guidelines (WCAG) 2.2, with
    that criterion's exceptions: Spacing, Equivalent, Inline, User agent control and Essential. This overrides the
    44 by 44 CSS pixels the skill lists, which is Success Criterion 2.5.5, Target Size (Enhanced), level AAA. The
    override is stated here because a vendored skill is never edited.
  - **A failure** is any criterion the view does not meet, whatever severity the skill gives it. It is the change's
    own when the change caused it: the failing element is one the job added, or that element, in the same state,
    met the criterion in the view at the job's base commit. A failure that element already had at the base commit
    was already there, even where the job's diff touches the element. Where the diff does not show which, the base
    view is driven once and the same measurement taken of the same element.
  - **A failure the change introduced** is fixed in the same job: it goes back to a builder before push authorisation
    is requested, and the repaired view is driven and audited again.
  - **A failure that was already there** is the card's to fix only where the card's acceptance criteria ask for
    that repair. Otherwise it does not ride along: it is filed as a follow-up card in `Backlog`, as the `to-tickets`
    skill says, and named under **Not done** in the pull request body with the card's number.
  - **The result is quoted** in the pull request body under `## Evidence`, after the screenshots, from the last audit of
    the tree being pushed: for each view, the skill's summary line, each finding's row with what became of it, and each
    step not run. The audit's full output is saved as **The saved records** below says. A body that says "no visual
    change" carries no audit.

## The saved records

- Visual work keeps two files beside the work log, where the reviewer reads them. The session saves the plan's
  `Visual direction` section as `.claude/worklog/<branch>-visual-direction.md` before the first builder handoff that
  changes the look, and saves it again whenever that section changes. The drive that takes the screenshots saves its
  accessibility audit's full output as `.claude/worklog/<branch>-accessibility.md` before that drive ends, and a later
  drive updates the file so that it holds the latest audit of every view the Evidence shows. The fresh review of the
  built tree is dispatched only once both files hold the direction that tree was built to and the audit of every view
  driven on it, because a reviewer without them cannot judge the look against its direction or its measured
  accessibility; a missing or older file is saved first.
