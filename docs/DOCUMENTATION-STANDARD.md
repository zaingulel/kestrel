# Documentation standard

This standard governs how a repository's human-facing documentation teaches the system as it is built: what a page is
for, what it covers, how it draws relationships, where its claims come from and how it stays true. Authors and
reviewers of new human-facing documentation read it before they write. It overrides no instruction: where an agent
instruction, a skill or a routine manual gives a rule, that rule wins, and this standard grants nobody a permission.
[The document index](../docs/README.md) names each document and its kind. Presentation follows
[the design system](DESIGN-SYSTEM.md) where the project has a user interface.

## The documentation format

A repository that runs the documentation sweep keeps four kinds of page, each answering one reader's question:

| Page | The reader's question | Purpose |
|---|---|---|
| The document index, `docs/README.md` | Which page answers my question? | Reference |
| The architecture overview | How is this system built, and why? | Explanation |
| The tours | How do I follow one thing the system does, from start to finish? | Learning |
| The diagram page | What does the system look like, part by part and step by step? | Explanation, each diagram with its text equivalent |

The scope table in [the sweep's manual](DOC-SWEEP.md) names the paths of these pages where the repository has them. The
sweep and its day-after triage keep them true and never add a page; a new page comes only through ordinary planned work.

## Start with the reader's question

Choose a purpose before choosing headings. [Diataxis](https://diataxis.fr/) separates four needs, and each page serves
one of them:

| Purpose | What the reader needs |
|---|---|
| Learning | A bounded worked example with prerequisites, observable progress and an explicit real or hypothetical boundary |
| Task | A route from a known starting state to a named outcome, including the relevant refusal and recovery |
| Reference | Exact significant contracts that can be consulted without following a story |
| Explanation | Relationships, boundaries and supported reasons that make the system understandable |

Purpose and authority are independent. An explanation describes; an instruction governs action; a record captures
evidence or a decision. A reference may carry an instruction contract. State the distinction where mixing would
mislead the reader, and link the authoritative home beside the explanation.

Lead with the answer in plain language. Introduce the project's fixed terms through [GLOSSARY.md](../GLOSSARY.md),
explain an abbreviation on first use, and connect each paragraph to the reader's next question. Keep a task's required
steps in order and disclose branch-specific detail beside the branch that needs it. Link the next useful page with a
reason to follow it; a list of filenames alone does not explain a reading path.

## Cover the system at the useful boundary

Use [arc42's architecture coverage](https://arc42.org/overview/) as questions to investigate: goals and constraints,
context, parts and interfaces, runtime scenarios, deployment boundaries, decisions, quality, risks and terminology.
Select the questions that change this reader's understanding or action. An absent answer becomes a named gap with its
consequence; an irrelevant question gets a reason for exclusion. Headings follow the answers, so an empty template
section adds nothing, and a starter section is filled or removed before its page is complete.

Separate the facts of this repository from what it reuses from elsewhere, and say which is which. At a significant
interface, supply or link the exact accepted inputs, prerequisites, outputs, success, valid zero, no-op, incomplete and
failure states, side effects and recovery that actually apply. Explain the important callers and ownership. Examples
help but do not substitute for the contract: an exit status for incomplete input differs from one for an empty result,
and a queued action differs from a confirmed one. Private functions need no individual documentation unless their
boundary matters to the reader.

## Draw relationships that prose alone obscures

Choose a view to answer a question. [C4](https://c4model.com/diagrams) offers context, container and component levels
and supporting dynamic and deployment views; use only the levels that add value. A context view shows the people and
outside systems the project exchanges data or control with; a container view shows its deployable parts and data
stores; a dynamic view shows who sends which message in one runtime scenario. These are choices for the subject, not a
universal set.

Give each diagram a question or caption, a boundary and scope, the project's own terms as labels, and labelled
relationships with their meaning and direction. Explain conditional paths, and distinguish decision flow, data flow and
enforcement. Draw a diagram as text the repository host renders, such as a Mermaid block, or as an image the design
system provides for, and keep a full text equivalent beside it: a relationship list for a map, the messages in order
for a sequence. Check the diagram, its text equivalent and the sources together; a picture and prose that match can
still share a wrong assumption.

## Reconstruct from sources

Read sources before reusing prose. [AGENTS.md](../AGENTS.md) indexes the sources of truth and
[the repository profile](../.agents/REPOSITORY.md) names the grounding authorities:

| Claim | Source that can establish it | Limit |
|---|---|---|
| Governing policy, approval, review or permitted action | The owning instruction, skill or specification | It establishes what should happen, not that an agent followed it |
| Implemented behavior, configuration or exact interface | Authored code and configuration, with relevant tests | Code shows implementation; a test supports only its exercised contract |
| A decision or its reason | An accepted decision or capture record actually read | Implementation alone cannot recover why a choice was made |
| An execution result or external state | A scoped receipt, observation or read-back record | A configured workflow, schedule or green status is not proof of the intended outcome |
| Runtime or provider behavior | Relevant primary documentation, versioned source or a bounded probe | Local registration does not establish runtime trust or unsupported-platform behavior |

Keep each governing meaning in its existing home. Explain the consequence and link it instead of creating a second
operating rule. Cite the source section or symbol that answers the question, close to the claim. A live implementation
claim points to the authored source; an installed or generated path is appropriate when describing what the runtime
reads. When they disagree, expose the difference rather than choose an invented policy. Unrecorded rationale stays
unknown; a reasoned inference is labelled as such.

Reuse only verified meaning. Changing typography or rearranging existing paragraphs cannot establish that omitted
interfaces, recovery paths or evidence now exist. An audit or assessment record supplies leads and dispositions, not
new rules, and its answers are revalidated against the sources before reuse.

## Evidence and maintenance

State evidence at the level it actually supports. A hypothetical example, an inspected test, an executed local check, a
historical probe and a current external read are different kinds of support. Qualify an unavailable observation next to
the affected claim and say what evidence would settle it. Keep evidence limits visible without attaching a formulaic
badge to every paragraph. Do not infer comprehension or successful operation from rendering or link checks.

[The testing strategy](TESTING-STRATEGY.md) owns the evidence a text-only change needs. Review meaning against
independently read sources and ask whether a plausible wrong claim or an omitted section would be noticed. Confirm
cited paths and anchors; a document lint does not establish that a link's target means what the text says.

Maintain affected documentation with the change that alters the behavior it explains. Recheck answers, diagrams, their
text equivalents, exact contracts and connected links against the changed source. Respect the owning instruction's edit
and publication route: the documentation sweep and its day-after triage follow this standard when they write or repair
a page, within the scope and permissions their own manuals set. Write current manuals, with history left to version
control. A review finishes when each consequential claim has an inspected source or a visible gap, the reader can reach
the next relevant page, and the applicable evidence is recorded.
