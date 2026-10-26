"""Admission: which input enters the conversation and which request may still speak."""

from collections.abc import Callable


class Admission:
    """Kestrel's rule for which input enters the conversation and which request may still speak. Tickets only, never text."""

    def __init__(self, *, voice: bool, output_switching: Callable[[], bool]) -> None:
        self._open = True
        self._voice = voice
        self._output_switching = output_switching
        self._input = object()
        self._speaker = None
        self._handover = None
        self._on_taken = None
        self._taken = None

    def is_open(self) -> bool:
        return self._open

    def admits_microphone(self) -> bool:
        return self._open and self._voice and self._handover is None and not self._output_switching()

    def may_speak(self, ticket) -> bool:
        return ticket is not None and self._open and ticket is self._speaker

    def is_current(self, mark) -> bool:
        return self._open and mark is self._input

    def input_mark(self) -> object:
        """Stamped on transcription frames; a later typed request makes it stale."""
        return self._input

    def accept_spoken(self) -> tuple[object, object]:
        self._speaker = object()
        return self._speaker, self._input

    def accept_typed(self, *, on_taken: Callable[[], None]) -> object:
        self._speaker = self._handover = object()
        self._on_taken = on_taken
        self._input = object()
        return self._speaker

    def take_typed(self, ticket) -> None:
        if ticket is None or ticket is not self._handover:
            return
        self._handover = None
        self._taken = ticket
        on_taken, self._on_taken = self._on_taken, None
        on_taken()

    def typed_taken(self, ticket) -> bool:
        return ticket is not None and ticket is self._taken

    def close(self) -> None:
        """Never reopens: a fresh conversation gets a fresh Admission."""
        self._open = False
