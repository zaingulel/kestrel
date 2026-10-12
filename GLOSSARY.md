# Kestrel glossary

The language of Kestrel, Zain's voice assistant, and of the workflow this repository is built with.

## Product

**Kestrel**:
Zain's voice assistant for his Omarchy desktop, as he experiences it, whatever it is made of.
_Avoid_: the prototype, the bot

**Voice**:
The part that listens to speech and speaks replies.
_Avoid_: speech stack, audio pipeline

**Brain**:
The model that understands a request and chooses what to do. A role that different models can fill.
_Avoid_: the model, the assistant, the name of whichever model fills the role

**Runtime**:
The software that gives the brain its tools and memory and carries out what it chooses.
_Avoid_: agent framework, hands

**Tool**:
One bounded thing Kestrel can do, with a result it can observe.
_Avoid_: skill, command, action

**Delegation**:
Kestrel passing a spoken instruction to a coding agent after reading it back and hearing the owner confirm it.
_Avoid_: handoff, which belongs to the workflow

**Note**:
A short remembered preference or correction.
_Avoid_: memory, fact

**Prototype**:
The current conversation-only build of Kestrel.
_Avoid_: trial

**Experiment**:
The work issue #1 describes, ending in a measured choice of brain and shape.
_Avoid_: trial, prototype

## Workflow

**Runtime assets**:
Ignored environments, model weights, microphone and voice assets under `.runtime/`.

**Factory**:
The shared Fabraik development workflow installed through canonical sync.

**Shared region**:
The text between the factory-shared markers in AGENTS.md.

**Local profile**:
`.agents/REPOSITORY.md`, the repository facts outside shared workflow bytes.
