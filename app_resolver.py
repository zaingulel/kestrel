"""Read the native installed-app index without importing Gio in the voice process."""

import json
import sys
import unicodedata


def valid_app_text(value: object, byte_limit: int) -> bool:
    if not isinstance(value, str):
        return False
    try:
        return len(value.encode('utf-8')) <= byte_limit and not any(unicodedata.category(c) == 'Cc' for c in value)
    except UnicodeEncodeError:
        return False


def valid_desktop_id(value) -> bool:
    return (valid_app_text(value, 1024) and bool(value) and value.endswith('.desktop')
            and value[0] not in '.-' and not any(c in '/\\:' for c in value))


def resolve_app(name: str, apps) -> str | None:
    matches = set()
    for app in apps:
        if not app.should_show():
            continue
        app_name = app.get_name()
        if not isinstance(app_name, str):
            raise ValueError('invalid app metadata')
        if app_name.strip().casefold() == name.strip().casefold():
            desktop_id = app.get_id()
            if not valid_desktop_id(desktop_id):
                raise ValueError('invalid app metadata')
            matches.add(desktop_id)
    return next(iter(matches)) if len(matches) == 1 else None


def main(argv=None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if args:
        print('Invalid app name', file=sys.stderr)
        return 1
    try:
        name = sys.stdin.buffer.read(1025).decode('utf-8', errors='strict')
    except UnicodeDecodeError:
        print('Invalid app name', file=sys.stderr)
        return 1
    if not valid_app_text(name, 1024) or not name.strip():
        print('Invalid app name', file=sys.stderr)
        return 1
    try:
        from gi.repository import Gio
    except ImportError:
        print('Gio unavailable', file=sys.stderr)
        return 1
    try:
        desktop_id = resolve_app(name, Gio.AppInfo.get_all())
    except (ValueError, TypeError, AttributeError, RuntimeError):
        print('Invalid installed-app metadata', file=sys.stderr)
        return 1
    print(json.dumps(desktop_id))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
