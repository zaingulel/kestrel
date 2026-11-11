---
description: This standard describes how a repository's human-facing documentation teaches the system as it stands. Read it before you write or review a page.
---

# Documentation standard

This standard says how a repository's human-facing documentation teaches the system as it stands. It covers what a
page is for, what it covers, where it lives, how it links and draws relationships, and how it stays true. Read it
before you write or review human-facing documentation.

It overrides no instruction. Where an agent instruction, a skill or a routine manual gives a rule, that rule wins, and
this standard grants nobody a permission. [The document index](../docs/README.md) names each document and its kind.
Where the project has a user interface, presentation follows [the design system](DESIGN-SYSTEM.md).

## The documentation format

A repository that runs the documentation sweep keeps four kinds of page, each answering one reader's question:

| Page | The reader's question | Purpose |
|---|---|---|
| The document index, `docs/README.md` | Which page answers my question? | Reference |
| The architecture overview | How is this system built, and why? | Explanation |
| The tours | How do I follow one thing the system does, from start to finish? | Learning |
| The diagram page | What does the system look like, part by part and step by step? | Explanation, each diagram with its text equivalent |

The scope table in [the sweep's manual](DOC-SWEEP.md) names the paths of these pages where the repository has them.
The sweep and its day-after triage keep them true and never add a page. Only ordinary planned work adds a page.

## One page, one place

The site renders each document in place. The Markdown file in the repository is the page, whether a reader opens it on
the rendered site or on the code host. No second copy of a page exists in another format, so no copy can drift from it.

Give each fact one home. Other pages link that home and never restate the fact, even in a paraphrase. A reader who
needs the detail follows the link, and that click is the price of a fact that stays true everywhere. A page may say
why the fact matters to its own reader, then link the home for the fact itself.

Write each prose link as a relative Markdown link to the document. The reader then stays on the rendered site, and the
same link resolves on the code host. Use a code-host address only for a file the site does not show, such as a script
or a settings file.

## Start with the reader's question

Choose a purpose before choosing headings. [Diataxis](https://diataxis.fr/) separates four needs, and each page serves
one of them:

| Purpose | What the reader needs |
|---|---|
| Learning | A bounded worked example with prerequisites, observable progress and an explicit real or hypothetical boundary |
| Task | A route from a known starting state to a named outcome, including the relevant refusal and recovery |
| Reference | Exact significant contracts that can be consulted without following a story |
| Explanation | Relationships, boundaries and supported reasons that make the system understandable |

Purpose and authority are independent. An explanation describes, an instruction governs action, and a record captures
evidence or a decision. A reference may carry an instruction contract. Where mixing them would mislead the reader, say
which a passage is, and link the instruction that governs it.

Lead with the answer in plain language. Introduce the project's fixed terms through [GLOSSARY.md](../GLOSSARY.md), and
explain an abbreviation on first use. Connect each paragraph to the reader's next question. Keep a task's required
steps in order, and put branch-specific detail beside the branch that needs it. Link the next useful page with a reason
to follow it, since a list of filenames alone does not explain a reading path.

## Cover the system at the useful boundary

Use [arc42's architecture coverage](https://arc42.org/overview/) as questions to investigate: goals and constraints,
context, parts and interfaces, runtime scenarios, deployment boundaries, decisions, quality, risks and terminology.
Select the questions that change this reader's understanding or action. An absent answer becomes a named gap with its
consequence, and an irrelevant question gets a reason for exclusion. Headings follow the answers, so an empty template
section adds nothing. Fill or remove a starter section before its page is complete.

Separate the facts of this repository from what it reuses from elsewhere, and say which is which. At a significant
interface, supply or link the contract that actually applies. That contract covers its accepted inputs, prerequisites
and outputs. It covers success, valid zero, no-op, incomplete and failure states, side effects and recovery. Explain
the important callers and ownership. Examples help but do not replace the contract. An exit status for incomplete input
differs from one for an empty result, and a queued action differs from a confirmed one. Private functions need no
individual documentation unless their boundary matters to the reader.

## Draw relationships that prose alone obscures

Choose a view to answer a question. [C4](https://c4model.com/diagrams) offers context, container and component levels,
and supporting dynamic and deployment views. Use only the levels that add value. A context view shows the people and
outside systems the project exchanges data or control with. A container view shows its deployable parts and data
stores. A dynamic view shows who sends which message in one runtime scenario. These are choices for the subject, not a
universal set.

Give each diagram a question or caption, a boundary and scope, the project's own terms as labels, and labelled
relationships with their meaning and direction. Explain conditional paths, and distinguish decision flow, data flow and
enforcement. Draw each diagram as a Mermaid block in the Markdown, so the rendered site and the code host both draw it.
Put a full text equivalent directly beneath it: a relationship list for a map, or the messages in order for a
sequence. Check the diagram, its text equivalent and the sources together, since a picture and prose that match can
still share a wrong assumption.

## Reconstruct from sources

Read sources before reusing prose. [AGENTS.md](../AGENTS.md) indexes the sources of truth, and
[the repository profile](../.agents/REPOSITORY.md) names the grounding authorities:

| Claim | Source that can establish it | Limit |
|---|---|---|
| Governing policy, approval, review or permitted action | The owning instruction, skill or specification | It establishes what should happen, not that an agent followed it |
| Implemented behavior, configuration or exact interface | Authored code and configuration, with relevant tests | Code shows implementation; a test supports only its exercised contract |
| A decision or its reason | An accepted decision or capture record actually read | Implementation alone cannot recover why a choice was made |
| An execution result or external state | A scoped receipt, observation or read-back record | A configured workflow, schedule or green status is not proof of the intended outcome |
| Runtime or provider behavior | Relevant primary documentation, versioned source or a bounded probe | Local registration does not establish runtime trust or unsupported-platform behavior |

Cite the source section or symbol that answers the question, close to the claim. A claim about how something is
implemented points to the authored source. An installed or generated path fits a claim about what the runtime reads.
Where two sources disagree, show the difference rather than choose an invented policy. A reason nobody recorded stays
unknown. Label a reasoned inference as one.

Reuse only verified meaning. Changing typography or rearranging paragraphs cannot show that a missing interface,
recovery path or piece of evidence exists. An audit or assessment record supplies leads and dispositions, not rules.
Check its answers against the sources before you reuse them.

## Evidence and maintenance

State evidence at the level it actually supports. A hypothetical example, an inspected test, an executed local check, a
historical probe and a current external read are different kinds of support. Qualify an unavailable observation next to
the affected claim, and say what evidence would settle it. Keep evidence limits visible without attaching a formulaic
badge to every paragraph. Rendering and link checks show neither that a reader understands nor that a system works.

[The testing strategy](TESTING-STRATEGY.md) owns the evidence a text-only change needs. Review meaning against
independently read sources, and ask whether a reviewer would notice a plausible wrong claim or a missing section.
Confirm cited paths and anchors, because a document lint does not show that a link's target means what the text says.

Maintain affected documentation with the change that alters the behavior it explains. Recheck answers, diagrams, their
text equivalents, exact contracts and connected links against the changed source. Respect the owning instruction's edit
and publication route. When the documentation sweep and its day-after triage write or repair a page, they follow this
standard. Each stays within the scope and permissions its own manual sets. Write current manuals, and leave history to
version control.

A review finishes when three things hold. Each consequential claim has an inspected source or a visible gap. The reader
can reach the next relevant page. The review records the applicable evidence.

## Where to go next

- [The sweep's manual](DOC-SWEEP.md) says which pages the documentation sweep keeps true, and how.
- [The testing strategy](TESTING-STRATEGY.md) says what evidence a documentation change needs.
- [The glossary](../GLOSSARY.md) defines the fixed terms a page introduces.
