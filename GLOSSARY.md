# Kestrel glossary

The language of Kestrel, Zain's voice assistant, and of the workflow this repository is built with.

## Product

**Kestrel**:
Zain's voice assistant for his Omarchy desktop, as he experiences it, whatever it is made of.
_Avoid_: the prototype, the bot

**Voice**:
The part that listens to speech and speaks replies.
_Avoid_: speech stack, audio pipeline

**Reply progress**:
Kestrel's record of how far a reply's speech has reached audio output, and how the reply ended.
_Avoid_: heard, which Kestrel cannot observe.

**Brain**:
The model that understands a request and chooses what to do. A role that different models can fill.
_Avoid_: the model, the assistant, the name of whichever model fills the role

**Engine**:
The software that gives the brain its tools and memory and carries out what it chooses.
_Avoid_: runtime, which belongs to the workflow; agent framework, hands

**Tool**:
One bounded thing Kestrel can do, with a result it can observe.
_Avoid_: skill, command, action

**Tool catalogue**:
The one list of every tool Kestrel provides, with each tool's facts.

**Delegation**:
Kestrel passing a spoken instruction to a coding agent after reading it back and hearing the owner confirm it.
_Avoid_: handoff, which belongs to the workflow

**Note**:
A short remembered preference or correction.
_Avoid_: memory, fact

**Prototype**:
The current build of Kestrel.
_Avoid_: trial

**Experiment**:
The work the [specification (#11)](https://github.com/zaingulel/kestrel/issues/11) describes, ending in a measured choice of brain and shape.
_Avoid_: trial, prototype

## Workflow

**Runtime assets**:
Ignored environments, model weights, microphone and voice assets under `.runtime/`.

**Factory**:
The shared Fabraik development workflow installed and updated through named releases, as the [shared-files skill](.agents/skills/shared-files/SKILL.md) defines.

**Shared region**:
The text between the factory-shared markers in AGENTS.md.

**Local profile**:
`.agents/REPOSITORY.md`, the repository facts outside shared workflow bytes.
