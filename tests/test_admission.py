import unittest

from admission import Admission


class AdmissionTests(unittest.TestCase):
    def test_dismissal_refuses_new_input_old_speech_and_earlier_input(self):
        admission = Admission(voice=True, output_switching=lambda: False)
        ticket, mark = admission.accept_spoken()
        self.assertTrue(admission.is_open())
        self.assertTrue(admission.admits_microphone())
        self.assertTrue(admission.may_speak(ticket))
        self.assertTrue(admission.is_current(mark))

        admission.close()

        self.assertFalse(admission.is_open())
        self.assertFalse(admission.admits_microphone())
        self.assertFalse(admission.may_speak(ticket))
        self.assertFalse(admission.is_current(mark))

        quiet = Admission(voice=False, output_switching=lambda: False)
        self.assertTrue(quiet.is_open())
        self.assertFalse(quiet.admits_microphone())


if __name__ == '__main__':
    unittest.main()
