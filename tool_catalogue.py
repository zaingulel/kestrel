"""Kestrel's desktop tool facts, admission and brain-facing contract."""

from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum
import json
import re

from app_resolver import valid_app_text


class PermissionTier(Enum):
    FREE = 'free'
    ASK = 'ask'
    FORBIDDEN = 'forbidden'


NUMBER_BASE_WORDS = (
    'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
    'seventeen', 'eighteen', 'nineteen',
)
NUMBER_TENS = ('twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety')
NUMBER_WORDS = {
    **{name: value for value, name in enumerate(NUMBER_BASE_WORDS)},
    **{name: value * 10 for value, name in enumerate(NUMBER_TENS, 2)},
    **{
        f'{name}{separator}{unit}': value * 10 + digit
        for value, name in enumerate(NUMBER_TENS, 2)
        for digit, unit in enumerate(NUMBER_BASE_WORDS[1:10], 1)
        for separator in (' ', '-')
    },
    'one hundred': 100,
}


def _read_volume(text: str) -> dict[str, int | str] | None:
    text = text.strip().lower()
    match = re.fullmatch(
        r'(?:(?P<leading_please>please) )?'
        r'(?P<command>volume|set (?:the )?volume(?: to)?) '
        r'(?P<level>0|[1-9][0-9]?|100|[a-z]+(?:[ -][a-z]+)*?)'
        r'(?P<unit> percent| ?%)?(?: (?P<trailing_please>please))?[.!]?', text,
    )
    if not match or (match['leading_please'] and match['trailing_please']):
        return None
    if match['command'] == 'volume' and match['unit'] is None:
        return None
    percent = int(match['level']) if match['level'].isdecimal() else NUMBER_WORDS.get(match['level'])
    return {'percent': percent} if percent is not None else None


def _read_workspace(text: str) -> dict[str, int | str] | None:
    text = text.strip().lower()
    match = re.fullmatch(r'workspace ([1-9][0-9]{0,9})[.!]?', text)
    if match:
        number = int(match[1])
    else:
        match = re.fullmatch(r'workspace ([a-z -]+)[.!]?', text)
        number = NUMBER_WORDS.get(match[1]) if match else None
    return {'number': number} if number is not None and 1 <= number <= 2147483647 else None


def _read_app(text: str) -> dict[str, int | str] | None:
    match = re.fullmatch(r'open ([^\r\n?!]+?)[.!]?', text.strip(), re.IGNORECASE)
    return {'name': match[1].strip()} if match else None


@dataclass(frozen=True)
class ToolSpec:
    description: str
    bounds: dict[str, tuple[type, int, int]]
    permission: PermissionTier
    allowed_after_outside_text: bool
    needs_lookup: bool
    plain_words: str
    phrase: str | Callable[[str], dict[str, int | str] | None]
    subject: str
    spoken: str
    counts_toward_stop: bool
    confirmation: str | None = None
    announcement: str | None = None
    failure_message: str | None = None
    unavailable_message: str | None = None
    lookup_failure: tuple[str, str] | None = None
    lookup_miss: tuple[str, str] | None = None
    extra_guidance: str = ''
    app_name_byte_limit: int | None = None


TOOL_CATALOGUE: dict[str, ToolSpec] = {
    'mute': ToolSpec('Mute the selected audio output.', {}, PermissionTier.FREE, True, False, 'muting',
                     phrase='mute', subject='mute', spoken='mute', counts_toward_stop=True,
                     announcement='Muting.',
                     failure_message="I couldn't confirm mute. Check the audio control. I won't retry."),
    'unmute': ToolSpec('Unmute the selected audio output.', {}, PermissionTier.FREE, True, False, 'unmuting',
                       phrase='unmute', subject='unmute', spoken='unmute', counts_toward_stop=True,
                       confirmation='Unmuted.',
                       failure_message="I couldn't confirm unmute. Check the audio control. I won't retry."),
    'set_volume': ToolSpec('Set the selected audio output volume.', {'percent': (int, 0, 100)},
                           PermissionTier.FREE, True, False, 'setting the volume',
                           phrase=_read_volume, subject='volume', spoken='set the volume to thirty',
                           counts_toward_stop=True, confirmation='Volume {percent}.',
                           failure_message="I couldn't confirm volume. Check the audio control. I won't retry."),
    'pause_media': ToolSpec('Pause current media.', {}, PermissionTier.FREE, True, False, 'pausing media',
                            phrase='pause music', subject='pause', spoken='pause music', counts_toward_stop=True,
                            failure_message="I couldn't confirm pause. Check the media player. I won't retry.",
                            unavailable_message="I couldn't find a playing media player."),
    'next_track': ToolSpec('Advance to the next media track.', {}, PermissionTier.FREE, True, False,
                           'skipping to the next track', phrase='next track', subject='next track',
                           spoken='next track', counts_toward_stop=True,
                           failure_message="I couldn't confirm next track. Check the media player. I won't retry.",
                           unavailable_message="I couldn't find a playing media player."),
    'focus_workspace': ToolSpec('Focus a numbered workspace.', {'number': (int, 1, 2147483647)},
                                PermissionTier.FREE, True, False, 'switching to a numbered workspace',
                                phrase=_read_workspace, subject='workspace', spoken='workspace three',
                                counts_toward_stop=True,
                                failure_message="I couldn't confirm workspace {number}. Check the desktop. I won't retry."),
    'open_app': ToolSpec('Open one installed app by its visible name.', {'name': (str, 1, 1024)},
                         PermissionTier.FREE, False, True, 'opening an installed app by name',
                         phrase=_read_app, subject='open app', spoken="open followed by an installed app's exact name",
                         counts_toward_stop=False, confirmation='Opening {name}.',
                         failure_message="I couldn't confirm the app opened. Check the desktop. I won't retry.",
                         lookup_failure=('app lookup failed',
                                         "I couldn't check the installed apps. I didn't send an open request. Use the app menu."),
                         lookup_miss=('no unique installed app',
                                      "I couldn't find exactly one installed app with that name, so I didn't open anything."),
                         extra_guidance='For open_app, confirmed means the launch request was accepted, not that a window is visible. ',
                         app_name_byte_limit=1024),
    'take_screenshot': ToolSpec('Save a screenshot to the screenshot folder; its content is never shown to you.', {},
                                PermissionTier.FREE, False, False, 'taking a screenshot',
                                phrase='take a screenshot', subject='screenshot', spoken='take a screenshot',
                                counts_toward_stop=False, confirmation='Screenshot saved.',
                                failure_message="I couldn't confirm the screenshot. Check your screenshot folder. I won't retry.",
                                extra_guidance='For take_screenshot, confirmed means a new screenshot file was saved; you never see it. '),
}


def match_local_phrase(text: str) -> tuple[str, dict[str, int | str]] | None:
    normalized = text.strip().lower()
    for name, spec in TOOL_CATALOGUE.items():
        if isinstance(spec.phrase, str):
            arguments = {} if normalized in (spec.phrase, spec.phrase + '.', spec.phrase + '!') else None
        else:
            arguments = spec.phrase(text)
        if arguments is not None and valid_desktop_arguments(name, arguments):
            return name, arguments
    return None


def valid_desktop_arguments(name: object, arguments: object) -> bool:
    if not isinstance(name, str) or name not in TOOL_CATALOGUE or not isinstance(arguments, dict):
        return False
    spec = TOOL_CATALOGUE[name]
    if not (set(arguments) == set(spec.bounds) and all(
        type(arguments[key]) is kind and (
            low <= arguments[key] <= high if kind is int
            else low <= len(arguments[key]) <= high and bool(arguments[key].strip()))
        for key, (kind, low, high) in spec.bounds.items()
    )):
        return False
    if spec.app_name_byte_limit is not None:
        return valid_app_text(arguments['name'], spec.app_name_byte_limit)
    return True


def desktop_schema(name: str) -> dict:
    spec = TOOL_CATALOGUE[name]
    return {'name': name, 'description': spec.description, 'parameters': {
        'type': 'object',
        'properties': {key: {'type': 'integer', 'minimum': low, 'maximum': high} if kind is int
                       else {'type': 'string', 'minLength': low, 'maxLength': high}
                       for key, (kind, low, high) in spec.bounds.items()},
        'required': list(spec.bounds), 'additionalProperties': False,
    }}


def desktop_tool_instructions() -> str:
    names = list(TOOL_CATALOGUE)
    plain_words = [spec.plain_words for spec in TOOL_CATALOGUE.values()]
    return (
        "native local memory for small facts and preferences, and Kestrel's desktop tools "
        + ', '.join(names[:-1]) + ' and ' + names[-1] + '. '
        "Maintain notes automatically when useful, including updating or removing outdated notes. "
        "Claim a save only after a successful memory tool result. You have no internet, web access or live "
        "information such as news, weather or prices, and you cannot see the screen or any screenshot; "
        "you cannot resume or go back in media. Say so plainly when asked. "
        "When asked what you can do, name conversation and general knowledge, remembering notes and each desktop tool "
        "in plain words (" + ', '.join(plain_words[:-1]) + ' and ' + plain_words[-1] + "), then state these limits, "
        "then say this sentence word for word: You can also say repeat that, stop, that's all, or what can I say. "
        "Call a desktop tool only when the owner clearly asks for that tool's effect, at most once per reply; "
        "when a request is unclear or asks for something no tool does, ask instead of calling a tool. "
        "Each desktop result is JSON with confirmed, attempted and reason. "
        "Say an effect happened only when confirmed is true, never before its result arrives. "
        + ''.join(spec.extra_guidance for spec in TOOL_CATALOGUE.values())
        + "Never call a desktop tool again to retry it.\n\n"
    )


def brain_result(confirmed: bool, attempted: bool, reason: str) -> str:
    return json.dumps({'confirmed': confirmed, 'attempted': attempted, 'reason': reason})


def valid_desktop_result(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip()) and len(value) <= 1024
