# Kestrel repository profile

Local facts live here; [AGENTS.md](../AGENTS.md) owns the always-loaded contract.

## Product

The current conversation prototype and the owner discovery boundary are defined in [AGENTS.md](../AGENTS.md#product). [README.md](../README.md) owns operation.

## Architecture seams

The product seams are in [AGENTS.md](../AGENTS.md#architecture-seams). Adopter-local workflow facts live in `scripts/lib/board-config.mjs` (Project 7, with the canonical Workstream options Go-to-market, Product and Platform), the document lint policy in `scripts/lib/doc-lint.mjs`, `package.json`, this profile and the manuals indexed in [docs/README.md](../docs/README.md). Shared paths are identified by `.agents/factory-manifest.json`; this repository has no shared source tree and does not author shared bytes. No optional local commit, turn-end or direct-main push gate is installed.

## Grounding

[GitHub ruleset readback](github-rulesets.json) records the live application programming interface response; the rules themselves remain owned by GitHub and the shared contract.

Use the installed Fabraik contract and canonical sync prerequisites for workflow decisions; official GitHub, Claude Code and Codex documentation for platform behaviour; the vendored upstream sources and licences for skills; README and the existing voice adapter tests for the prototype. Product direction requires discovery and drilling with the owner. [GLOSSARY.md](../GLOSSARY.md) owns local terms.

## Conventions

| Convention | Kestrel |
|---|---|
| generated artifacts | Shared files and `.agents/factory-manifest.json` are installed by canonical sync; never edit them locally. `package-lock.json` is generated from `package.json` by npm and committed with dependency changes. |
| visual verification | Conversation uses native laptop audio with no browser client. Approved future panel and indicator patterns live in [docs/DESIGN-SYSTEM.md](../docs/DESIGN-SYSTEM.md). The native mute-failure notification pattern is defined in [docs/DESIGN-SYSTEM.md](../docs/DESIGN-SYSTEM.md). Visual work follows AGENTS and the resume skill. |
| fixtures | The existing Python adapter tests use doubles; factory tests build their own isolated fixtures. Local recorded samples and model assets remain ignored in `.runtime/`. |
| documentation routines | Inactive: no documentation sweep, day-after triage or weekly retro is scheduled or authorised. The inactive sweep and triage manuals require owner activation before any routine runs. |
