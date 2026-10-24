"""Reply progress: how far each reply's speech has reached audio output, and how the reply ended."""

from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import NamedTuple

from pipecat.frames.frames import (
    DataFrame, InterruptionFrame, LLMAssistantPushAggregationFrame, LLMFullResponseEndFrame, LLMFullResponseStartFrame,
    LLMTextFrame, OutputAudioRawFrame, StartFrame, TTSAudioRawFrame, TTSSpeakFrame, TTSStartedFrame, TTSStoppedFrame,
    TTSTextFrame,
)
from pipecat.transports.base_transport import TransportParams


class SpeechAdvisoryFrame(LLMTextFrame):
    """Fixed application speech that generated syntax cannot suppress."""


class AnnouncementMarkFrame(DataFrame):
    """Its output push follows the full synthesis and playback of the announcement pushed before it."""


@dataclass
class ConversationSynthesisFailedFrame(DataFrame):
    reply_progress: 'ReplyProgress'
    section: 'ReplySection'


# Every non-audio frame of a reply carries its record as `frame.reply_progress`; a frame of no reply carries None.
REPLY_MESSAGES = (LLMFullResponseStartFrame, LLMTextFrame, SpeechAdvisoryFrame, TTSSpeakFrame,
                  AnnouncementMarkFrame, InterruptionFrame, TTSStartedFrame, TTSTextFrame, TTSStoppedFrame,
                  LLMFullResponseEndFrame, LLMAssistantPushAggregationFrame, ConversationSynthesisFailedFrame)


def token_of(frame) -> object | None:
    record = getattr(frame, 'reply_progress', None)
    return record.token if record is not None else None


class TextSpan(NamedTuple):
    section: 'ReplySection'
    start: int
    end: int
    valid: bool
    audible: bool


@dataclass(eq=False)
class ReplySection:
    """One native audio stream of a reply; byte positions are 48000 Hz mono PCM source bytes."""
    reply: 'ReplyProgress'
    delivery: str = 'neutral'
    source_bytes: int = 0
    previous_text_end: int = 0
    pending_text_starts: list[tuple[int, str]] = field(default_factory=list)
    source_valid: bool = True
    output_bytes: int = 0
    output_stopped: bool = False

    def skip_text(self) -> None:
        self.previous_text_end = self.source_bytes
        self.reply._sentence_audible = False


class ReplyProgress:
    """One reply's record. Generation calls work at any time; output and ending calls are ignored once closed."""

    def __init__(self, token, *, feed, feed_open: Callable[[], bool], on_finish=None):
        self.token = token
        self.feed = feed
        self.feed_open = feed_open
        self.on_finish = on_finish
        self.delivery = 'neutral'
        self.answer_failed = False
        self.interrupting = False
        self.sections: list[ReplySection] = []
        self.spans: list[TextSpan] = []
        self.incomplete = False
        self.synthesis_failed = False
        self.write_failed = False
        self.idle = True
        self.delivered = False
        self.closed = False
        self.completed = False
        self._sentence_audible = False
        self._streamed = set()
        self._text_starts = {}
        self._sources = {}
        self._frame_sections = {}
        self._text_spans = {}
        if feed is not None:
            feed.begin_reply(token)

    @classmethod
    def failed_before_speech(cls, token, feed) -> 'ReplyProgress':
        record = cls(token, feed=feed, feed_open=lambda: True)
        record.finish(failed=True)
        return record

    @classmethod
    def silent(cls, token) -> 'ReplyProgress':
        record = cls(token, feed=None, feed_open=lambda: False)
        record.closed = True
        return record

    def open_section(self, delivery: str) -> ReplySection:
        section = ReplySection(self, delivery=delivery)
        self.sections.append(section)
        return section

    def starts_text(self, frame, text: str) -> None:
        self._text_starts[frame.id] = text

    def text_started_by(self, frame) -> str | None:
        return self._text_starts.get(frame.id)

    def stream_frame(self, frame, section: ReplySection) -> None:
        if frame.id in self._streamed:
            return
        self._streamed.add(frame.id)
        if isinstance(frame, TTSAudioRawFrame):
            section.source_valid &= frame.sample_rate == 48000 and frame.num_channels == 1 and len(frame.audio) % 2 == 0
            text = self._text_starts.get(frame.id)
            if section.source_valid and text is not None:
                section.pending_text_starts.append((section.source_bytes, text))
            start = section.source_bytes
            # The transport plays the bytes whether or not they are valid source audio.
            section.source_bytes += len(frame.audio)
            self._sources[frame.id] = (section, start, section.source_bytes)
            if frame.audio:
                self._sentence_audible = True
            return
        frame.reply_progress = self
        self._frame_sections[frame.id] = section
        if isinstance(frame, TTSTextFrame) and frame.text.strip():
            self._text_spans[frame.id] = TextSpan(section, section.previous_text_end, section.source_bytes,
                                                  section.source_valid, self._sentence_audible)
            section.previous_text_end = section.source_bytes
            self._sentence_audible = False

    def section_of(self, frame) -> ReplySection | None:
        return self._frame_sections.get(frame.id)

    def span_of(self, text_frame) -> TextSpan | None:
        return self._text_spans.get(text_frame.id)

    def source_range(self, frame) -> tuple[ReplySection, int, int] | None:
        return self._sources.get(frame.id)

    def output_frame(self, frame) -> None:
        if self.closed or not self.feed_open():
            return
        if isinstance(frame, TTSStartedFrame):
            self.idle = False
        elif isinstance(frame, TTSStoppedFrame):
            section = self.section_of(frame)
            if section is not None:
                section.output_stopped = True
            self.idle = True
            if self.synthesis_failed:
                self.finish(failed=True, interrupted=self.interrupting)
        elif isinstance(frame, TTSTextFrame):
            if frame.text.strip():
                span = self.span_of(frame)
                if span is None or not span.valid or not span.audible:
                    self.incomplete = True
                elif span.end > span.start:
                    self.spans.append(span)
        elif isinstance(frame, ConversationSynthesisFailedFrame):
            self.synthesis_failed = True
            # A failure behind audio still playing waits for that audio's output stop.
            if frame.section.output_stopped and self.idle:
                self.finish(failed=True, interrupted=self.interrupting)
        elif isinstance(frame, LLMFullResponseEndFrame):
            self.finish(failed=self.answer_failed or self.output_failed(), interrupted=self.interrupting)
        elif isinstance(frame, InterruptionFrame):
            self.finish(interrupted=True)

    def credit(self, section: ReplySection, start: int, end: int) -> None:
        if self.closed or not self.feed_open():
            return
        self.idle = False
        section.output_bytes = end
        if self.write_failed:
            return
        # Credits within a section arrive in source order, so an earlier start left behind was discarded unplayed.
        while section.pending_text_starts and section.pending_text_starts[0][0] < end:
            byte, text = section.pending_text_starts.pop(0)
            if byte < start:
                continue
            if text.strip():
                self.delivered = True
            if self.feed is not None:
                self.feed.spoken(self.token, text)

    def output_lost(self) -> None:
        if not self.closed:
            self.incomplete = True

    def output_write_failed(self) -> None:
        if not self.closed:
            self.write_failed = True

    def output_failed(self) -> bool:
        return (self.incomplete or self.synthesis_failed or self.write_failed
                or any(span.end > span.section.output_bytes for span in self.spans))

    def finish(self, *, interrupted=False, failed=False) -> None:
        if self.closed:
            return
        self.closed = True
        if self.feed is not None and self.feed_open():
            self.feed.finish(self.token, interrupted=interrupted, failed=failed)
        self.completed = self.delivered and not (interrupted or failed)
        if self.on_finish is not None:
            self.on_finish(self)


class OutputBuffer:
    """Mirror of one output transport's chunk queue and unchunked remainder, tagging each byte with its section.

    Entries are (section, start, end) source ranges; section is None for audio no open record streamed.
    """

    def __init__(self, sample_rate: int, chunk_bytes: int):
        self.sample_rate = sample_rate
        self.chunk_bytes = chunk_bytes
        self.misaligned = False
        self._chunks = deque()
        self._open = []
        self._open_bytes = 0
        self._last_stop = None

    @classmethod
    def for_params(cls, params: TransportParams) -> 'OutputBuffer':
        rate = params.audio_out_sample_rate
        if not rate:
            raise ValueError('The output audio mirror needs a fixed output sample rate')
        return cls(rate, int(rate / 100) * params.audio_out_channels * 2 * params.audio_out_10ms_chunks)

    def enter(self, frame, record: 'ReplyProgress | None') -> None:
        if isinstance(frame, StartFrame):
            self._chunks.clear()
            self._open.clear()
            self._open_bytes = 0
        elif isinstance(frame, TTSStoppedFrame):
            # The transport flushes its remainder, padded with silence, ahead of the stop.
            if self._open:
                self._chunks.append(self._open)
                self._open = []
                self._open_bytes = 0
        elif isinstance(frame, OutputAudioRawFrame):
            if self.misaligned:
                if record is not None:
                    record.output_lost()
            elif frame.sample_rate != self.sample_rate:
                # The transport's resampler can now hold bytes this mirror cannot see.
                self._misalign(record)
            elif frame.audio:
                source = record.source_range(frame) if record is not None else None
                self._open.append(source if source is not None else (None, 0, len(frame.audio)))
                self._open_bytes += len(frame.audio)
                while self._open_bytes >= self.chunk_bytes:
                    self._chunks.append(self._take_chunk())

    def written(self, frame) -> list[tuple[ReplySection, int, int]]:
        if not self._chunks:
            if not self.misaligned:
                self._misalign(None)
            return []
        return [entry for entry in self._chunks.popleft() if entry[0] is not None]

    def write_failed(self, frame) -> None:
        if self._chunks:
            self._chunks.popleft()

    def stopped_speaking(self, frame) -> None:
        # The transport pushes each speaking stop as a sibling pair through this one output.
        if frame.broadcast_sibling_id is not None and frame.broadcast_sibling_id == self._last_stop:
            return
        self._last_stop = frame.id
        self._discard_open()

    def queue_dropped(self) -> None:
        self._chunks.clear()

    def _take_chunk(self) -> list:
        chunk, needed = [], self.chunk_bytes
        while needed:
            section, start, end = self._open[0]
            if end - start <= needed:
                chunk.append(self._open.pop(0))
                needed -= end - start
            else:
                chunk.append((section, start, start + needed))
                self._open[0] = (section, start + needed, end)
                needed = 0
        self._open_bytes -= self.chunk_bytes
        return chunk

    def _discard_open(self) -> None:
        for section, _, _ in self._open:
            if section is not None:
                section.reply.output_lost()
        self._open.clear()
        self._open_bytes = 0

    def _misalign(self, record: 'ReplyProgress | None') -> None:
        self.misaligned = True
        if record is not None:
            record.output_lost()
        self._discard_open()
