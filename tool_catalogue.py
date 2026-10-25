"""Kestrel's desktop tool facts, admission and brain-facing contract."""

from dataclasses import dataclass
from enum import Enum
import json

from app_resolver import valid_app_text


class PermissionTier(Enum):
    FREE = 'free'
    ASK = 'ask'
    FORBIDDEN = 'forbidden'


@dataclass(frozen=True)
class ToolSpec:
    description: str
    bounds: dict[str, tuple[type, int, int]]
    permission: PermissionTier
    allowed_after_outside_text: bool
    needs_lookup: bool
    plain_words: str
    extra_guidance: str = ''
    app_name_byte_limit: int | None = None


TOOL_CATALOGUE: dict[str, ToolSpec] = {
    'mute': ToolSpec('Mute the selected audio output.', {}, PermissionTier.FREE, True, False, 'muting'),
    'unmute': ToolSpec('Unmute the selected audio output.', {}, PermissionTier.FREE, True, False, 'unmuting'),
    'set_volume': ToolSpec('Set the selected audio output volume.', {'percent': (int, 0, 100)},
                           PermissionTier.FREE, True, False, 'setting the volume'),
    'pause_media': ToolSpec('Pause current media.', {}, PermissionTier.FREE, True, False, 'pausing media'),
    'next_track': ToolSpec('Advance to the next media track.', {}, PermissionTier.FREE, True, False,
                           'skipping to the next track'),
    'focus_workspace': ToolSpec('Focus a numbered workspace.', {'number': (int, 1, 2147483647)},
                                PermissionTier.FREE, True, False, 'switching to a numbered workspace'),
    'open_app': ToolSpec('Open one installed app by its visible name.', {'name': (str, 1, 1024)},
                         PermissionTier.FREE, False, True, 'opening an installed app by name',
                         'For open_app, confirmed means the launch request was accepted, not that a window is visible. ',
                         app_name_byte_limit=1024),
    'take_screenshot': ToolSpec('Save a screenshot to the screenshot folder; its content is never shown to you.', {},
                                PermissionTier.FREE, False, False, 'taking a screenshot',
                                'For take_screenshot, confirmed means a new screenshot file was saved; you never see it. '),
}


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
