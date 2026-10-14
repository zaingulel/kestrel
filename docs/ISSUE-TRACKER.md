# Issue tracker

## The tracker

Issues are GitHub Issues on `zaingulel/kestrel`, reached through `gh`. Planned work lives on the owner's Project 7 board, read with `node scripts/board.mjs`. `scripts/lib/board-config.mjs` owns the board schema and labels.

Add a card with `node scripts/board-add.mjs <issue> <Status> <Workstream>`. The Workstream field uses the canonical options Go-to-market, Product and Platform: launch or commercial work, product work, and repository tooling respectively. Factory setup issue #2 belongs to Platform; the product specification [issue #11](https://github.com/zaingulel/kestrel/issues/11) belongs to Product. This routing convention decides no product features. Labels come from the repository's existing set; never create labels during issue filing. Every issue carries exactly one kind label from `KIND_LABELS`, plus existing area labels that fit. Native blocker and parent links follow the to-issues skill.

## Issue body sections

Kestrel adds no sections to the to-issues template. The to-issues skill owns filing and owner approval. Inactive documentation routines provide no exception to that approval.

## Triage labels

Board Status is the triage state; there are no local triage labels. An upstream ready-for-agent label maps to no label here: a spec is a parent in Backlog; its build cards are work orders.

## Publishing specifications

The to-spec skill publishes one epic issue through to-issues, including owner approval, and cards it in Backlog. The owner decomposes it into linked build cards. No product implementation precedes owner discovery and drilling.

## Wayfinding operations

Maps are epic issues in Backlog. Tickets are task issues in Backlog under the map's Workstream, titled `<Type>: <question>` with Type Research, Prototype, Grilling or Task, linked as sub-issues. Use native blocker links. Read back every sub-issue and blocker before charting ends. The frontier is the map's open, unassigned tickets in map order, excluding those with open blockers. Claim with `gh issue edit <ticket> --add-assignee @me`; release an existing claim only after owner confirmation that no session holds it. Resolve by posting the answer, closing the ticket and recording the context pointer on the map. These actions remain subject to the invoked skill and owner authorisation.

## Throwaway branches and prototypes

Research and prototype branches live in their own job worktrees, cut from origin/main. Commit locally and never push; the issue pointer names the local branch. A builder runs prototype preservation evidence for unchanged shared bytes, and the coordinator owns convergence, as the shared skills and builder charter require.
