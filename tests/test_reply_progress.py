import unittest

from pipecat.frames.frames import (
    BotStoppedSpeakingFrame, LLMFullResponseEndFrame, InterruptionFrame, OutputAudioRawFrame, TTSAudioRawFrame,
    TTSStartedFrame, TTSStoppedFrame, TTSTextFrame,
)

import bot
import reply_progress


class ReplyProgressTests(unittest.TestCase):
    """The output mirror and reply records, stepped through in the order the output transport plays audio."""

    def setUp(self):
        self.feed = bot.ConversationFeed()
        self.buffer = reply_progress.OutputBuffer(48000, 3840)

    def reply(self):
        return reply_progress.ReplyProgress(object(), feed=self.feed, feed_open=lambda: True)

    def rows(self):
        return [(row['text'], row['state']) for row in self.feed.turns]

    def gen(self, section, frame):
        section.reply.stream_frame(frame, section)
        return frame

    def audio(self, section, size, text=None):
        frame = TTSAudioRawFrame(bytes(size), 48000, 1)
        if text is not None:
            section.reply.starts_text(frame, text)
        return self.gen(section, frame)

    def text(self, section, text):
        return self.gen(section, TTSTextFrame(text, aggregated_by='sentence'))

    def stop(self, section):
        return self.gen(section, TTSStoppedFrame())

    def enter(self, record, *frames):
        for frame in frames:
            self.buffer.enter(frame, record)

    def chunk(self):
        for entry in self.buffer.written(TTSAudioRawFrame(bytes(3840), 48000, 1)):
            entry[0].reply.credit(*entry)

    def out(self, *frames):
        for frame in frames:
            frame.reply_progress.output_frame(frame)

    def pair(self):
        downstream, upstream = BotStoppedSpeakingFrame(), BotStoppedSpeakingFrame()
        upstream.broadcast_sibling_id = downstream.id
        downstream.broadcast_sibling_id = upstream.id
        return downstream, upstream

    def out_pair(self):
        for frame in self.pair():
            self.buffer.stopped_speaking(frame)

    def out_stop(self, stop):
        # A section that wrote audio since the previous stop reaches its output stop after the stop-triggered pair.
        self.out_pair()
        self.out(stop)

    def labelled(self, frame, record):
        frame.reply_progress = record
        return frame

    def end(self, record):
        self.out(self.labelled(LLMFullResponseEndFrame(), record))

    def interrupt(self, record):
        self.out(self.labelled(InterruptionFrame(), record))
        self.buffer.queue_dropped()

    def opened(self, record, size, text):
        section = record.open_section('neutral')
        return section, self.gen(section, TTSStartedFrame()), self.audio(section, size, text), self.text(section, text)

    def section_a(self, record, size=3840):
        a, start, a_audio, ta = self.opened(record, size, 'First.')
        return a, start, a_audio, ta, self.stop(a)

    def crossing(self, record, *, late_stop=None):
        """Base output up to and including the chunk that crosses from section B into C; returns C."""
        _, start, a_audio, ta, sa = self.section_a(record)
        b = record.open_section('neutral')
        b_audio, tb = self.audio(b, 3000, 'Second.'), self.text(b, 'Second.')
        c = record.open_section('neutral')
        c_audio = self.audio(c, 3840, 'Third.')
        self.enter(record, a_audio, sa)
        if late_stop is not None:
            # The old reply's late chunk is first in the one first-in, first-out queue.
            self.chunk()
        self.out(start)
        if late_stop is not None:
            self.out(late_stop)
        self.chunk()
        self.out(ta)
        self.out_stop(sa)
        self.enter(record, b_audio, c_audio)
        self.out(tb)
        self.chunk()
        return c

    def close_section(self, section, text):
        tc, sc = self.text(section, text), self.stop(section)
        self.enter(section.reply, tc, sc)
        self.out(tc)
        self.chunk()
        self.out_stop(sc)

    def test_mirror_credits_output_across_sections(self):
        with self.subTest('(1) crossing chunk'):
            self.setUp()
            record = self.reply()
            c = self.crossing(record)
            self.assertEqual(self.rows(), [('First. Second. Third.', 'speaking')])
            self.close_section(c, 'Third.')
            self.end(record)
            self.assertEqual(self.rows(), [('First. Second. Third.', 'complete')])

        with self.subTest("(2) reviewer's 3000 plus 600"):
            self.setUp()
            record = self.reply()
            _, start, a_audio, ta, sa = self.section_a(record)
            b = record.open_section('neutral')
            b_audio, tb = self.audio(b, 3000, 'Second.'), self.text(b, 'Second.')
            c = record.open_section('neutral')
            c_audio, tc, sc = self.audio(c, 600, 'Third.'), self.text(c, 'Third.'), self.stop(c)
            self.enter(record, a_audio, sa)
            self.out(start)
            self.chunk()
            self.out(ta)
            self.out_stop(sa)
            self.enter(record, b_audio, c_audio, sc)
            self.out(tb, tc)
            self.chunk()
            self.assertEqual(self.rows(), [('First. Second. Third.', 'speaking')])
            self.out_stop(sc)
            self.end(record)
            self.assertEqual(self.rows(), [('First. Second. Third.', 'complete')])

        with self.subTest('(4) stop padding'):
            self.setUp()
            record = self.reply()
            _, start, a_audio, ta, sa = self.section_a(record, 3000)
            b = record.open_section('neutral')
            b_audio, tb, sb = self.audio(b, 3840, 'Second.'), self.text(b, 'Second.'), self.stop(b)
            self.enter(record, a_audio, sa, b_audio, sb)
            self.out(start, ta)
            self.chunk()
            self.out_stop(sa)
            self.assertEqual(self.rows(), [('First.', 'speaking')])
            self.chunk()
            self.out(tb)
            self.out_stop(sb)
            self.end(record)
            self.assertEqual(self.rows(), [('First. Second.', 'complete')])

        with self.subTest('(5) discarded tail'):
            self.setUp()
            record = self.reply()
            _, start, a_audio, ta, sa = self.section_a(record)
            b = record.open_section('neutral')
            b_audio, tb = self.audio(b, 3840, 'Second.'), self.text(b, 'Second.')
            late_audio, tl = self.audio(b, 1000, 'Late.'), self.text(b, 'Late.')
            c = record.open_section('neutral')
            c_audio, tc, sc = self.audio(c, 3840, 'Third.'), self.text(c, 'Third.'), self.stop(c)
            self.enter(record, a_audio, sa)
            self.out(start)
            self.chunk()
            self.out(ta)
            self.out_stop(sa)
            self.enter(record, b_audio, late_audio)
            self.chunk()
            self.out(tb, tl)
            self.assertEqual(self.rows(), [('First. Second.', 'speaking')])
            # The 3 s idle fallback stops speaking and clears B's unchunked 1000 bytes.
            self.out_pair()
            self.assertEqual(self.rows(), [('First. Second.', 'speaking')])
            self.enter(record, c_audio, sc)
            self.chunk()
            self.out(tc)
            self.out_stop(sc)
            self.end(record)
            self.assertEqual(self.rows(), [('First. Second. Third.', 'failed')])

        with self.subTest('(6) discard after an exact boundary'):
            self.setUp()
            record = self.reply()
            _, start, a_audio, ta, sa = self.section_a(record)
            b = record.open_section('neutral')
            b_audio, tb = self.audio(b, 3840, 'Second.'), self.text(b, 'Second.')
            c = record.open_section('neutral')
            c_audio, tc = self.audio(c, 3000, 'Third.'), self.text(c, 'Third.')
            d = record.open_section('neutral')
            d_audio, td, sd = self.audio(d, 600, 'Fourth.'), self.text(d, 'Fourth.'), self.stop(d)
            self.enter(record, a_audio, sa)
            self.out(start)
            self.chunk()
            self.out(ta)
            self.out_stop(sa)
            self.enter(record, b_audio)
            self.chunk()
            self.out(tb)
            self.enter(record, c_audio)
            self.out(tc)
            self.assertEqual(self.rows(), [('First. Second.', 'speaking')])
            self.out_pair()
            self.enter(record, d_audio, sd)
            self.chunk()
            self.out(td)
            self.out_stop(sd)
            self.end(record)
            self.assertEqual(self.rows(), [('First. Second. Fourth.', 'failed')])

        with self.subTest('(7) one stop per sibling pair'):
            self.setUp()
            record = self.reply()
            _, start, a_audio, ta, sa = self.section_a(record)
            b = record.open_section('neutral')
            b_audio, tb = self.audio(b, 3840, 'Second.'), self.text(b, 'Second.')
            c = record.open_section('neutral')
            c_audio, tc, sc = self.audio(c, 600, 'Third.'), self.text(c, 'Third.'), self.stop(c)
            self.enter(record, a_audio, sa)
            self.out(start)
            self.chunk()
            self.out(ta)
            self.out_stop(sa)
            self.enter(record, b_audio)
            self.chunk()
            self.out(tb)
            downstream, upstream = self.pair()
            self.buffer.stopped_speaking(downstream)
            self.enter(record, c_audio)
            self.buffer.stopped_speaking(upstream)
            self.enter(record, sc)
            self.chunk()
            self.out(tc)
            self.out_stop(sc)
            self.end(record)
            self.assertEqual(self.rows(), [('First. Second. Third.', 'complete')])

        with self.subTest('(8) stop-triggered clear inside a live section'):
            self.setUp()
            record = self.reply()
            _, start, a_audio, ta, sa = self.section_a(record)
            b = record.open_section('neutral')
            b_audio, tb = self.audio(b, 1000, 'Second.'), self.text(b, 'Second.')
            next_audio, tn, sb = self.audio(b, 3840, 'Next.'), self.text(b, 'Next.'), self.stop(b)
            # Generation runs ahead of playback: B's first bytes are unchunked when A's stop is played.
            self.enter(record, a_audio, sa, b_audio)
            self.out(start)
            self.chunk()
            self.out(ta)
            self.out_stop(sa)
            self.out(tb)
            self.enter(record, next_audio, sb)
            self.chunk()
            self.assertEqual(self.rows(), [('First. Next.', 'speaking')])
            self.out(tn)
            self.out_stop(sb)
            self.end(record)
            self.assertEqual(self.rows(), [('First. Next.', 'failed')])

    def test_interruption_after_crossing_keeps_started_text(self):
        record = self.reply()
        c = self.crossing(record)
        tc = self.text(c, 'Third.')
        fourth = self.audio(c, 3840, 'Fourth.')
        sc = self.stop(c)
        self.enter(record, fourth)
        self.out(self.labelled(InterruptionFrame(), record))
        self.assertEqual(self.rows(), [('First. Second. Third.', 'interrupted')])
        # The chunk the old audio task finished writing before it was cancelled, then the interruption's stop.
        self.chunk()
        self.out_pair()
        self.buffer.queue_dropped()
        self.out(tc, sc)
        self.end(record)
        self.assertEqual(self.rows(), [('First. Second. Third.', 'interrupted')])

    def test_failed_stale_and_leftover_output(self):
        with self.subTest('failed'):
            self.setUp()
            record = self.reply()
            c = self.crossing(record)
            self.out(reply_progress.ConversationSynthesisFailedFrame(reply_progress=record, section=record.sections[1]))
            self.assertEqual(self.rows(), [('First. Second. Third.', 'speaking')])
            self.close_section(c, 'Third.')
            self.assertEqual(self.rows(), [('First. Second. Third.', 'failed')])
            self.end(record)
            self.assertEqual(self.rows(), [('First. Second. Third.', 'failed')])

        with self.subTest('stale'):
            self.setUp()
            old = self.reply()
            so, old_start, old_audio, to = self.opened(old, 7680, 'Old.')
            old_stop = self.stop(so)
            self.enter(old, old_audio)
            self.out(old_start)
            self.chunk()
            self.out(to)
            # Finished without a queue drop, so its second chunk stays queued.
            old.finish(interrupted=True)
            record = self.reply()
            c = self.crossing(record, late_stop=old_stop)
            self.close_section(c, 'Third.')
            self.end(record)
            self.assertEqual(self.rows(), [('Old.', 'interrupted'), ('First. Second. Third.', 'complete')])

        with self.subTest('leftover'):
            self.setUp()
            old = self.reply()
            _, old_start, old_audio, to = self.opened(old, 1000, 'Old.')
            self.enter(old, old_audio)
            self.out(old_start, to)
            # Nothing was written, so the transport is not speaking and keeps the old reply's bytes.
            self.interrupt(old)
            record = self.reply()
            n, start, first, tf = self.opened(record, 3000, 'First.')
            future = self.audio(n, 3840, 'Future.')
            self.text(n, 'Future.')
            self.enter(record, first, future)
            self.out(start)
            self.chunk()
            self.out(tf)
            self.assertEqual(self.rows(), [('', 'interrupted'), ('First.', 'speaking')])
            self.interrupt(record)
            self.assertEqual(self.rows(), [('', 'interrupted'), ('First.', 'interrupted')])

    def test_malformed_audio_fails_the_reply(self):
        with self.subTest('(a) invalid span'):
            self.setUp()
            record = self.reply()
            section, start, good, t_good = self.opened(record, 3840, 'Good.')
            # An odd length is invalid source audio at the output rate, so the mirror stays aligned.
            bad, t_bad, stop = self.audio(section, 3841, 'Bad.'), self.text(section, 'Bad.'), self.stop(section)
            self.enter(record, good, bad, stop)
            self.out(start)
            self.chunk()
            self.out(t_good)
            self.chunk()
            self.out(t_bad)
            self.chunk()
            self.out_stop(stop)
            self.end(record)
            self.assertEqual(self.rows(), [('Good.', 'failed')])

        with self.subTest('(b) off-rate entry'):
            self.setUp()
            record = self.reply()
            section, start, good, t_good = self.opened(record, 3840, 'Good.')
            stop = self.stop(section)
            # Foreign audio no section generated, entered while nothing is open.
            self.enter(record, good, OutputAudioRawFrame(bytes(1000), 24000, 1), stop)
            self.out(start)
            self.chunk()
            self.out(t_good)
            self.out_stop(stop)
            self.end(record)
            self.assertEqual(self.rows(), [('Good.', 'failed')])
            record = self.reply()
            section, start, next_audio, t_next = self.opened(record, 3840, 'Next.')
            stop = self.stop(section)
            self.enter(record, next_audio, stop)
            self.out(start)
            self.chunk()
            self.out(t_next)
            self.out_stop(stop)
            self.end(record)
            self.assertEqual(self.rows(), [('Good.', 'failed'), ('', 'failed')])


if __name__ == '__main__':
    unittest.main()
