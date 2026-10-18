"""Read the native installed-app index without importing Gio in the voice process."""

import json
import sys
import unicodedata


def valid_desktop_id(value) -> bool:
    return (isinstance(value, str) and bool(value) and len(value.encode('utf-8')) <= 1024
            and value.endswith('.desktop') and value[0] not in '.-'
            and not any(c in '/\\:' or unicodedata.category(c) == 'Cc' for c in value))


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
    if (len(args) != 1 or not args[0].strip() or len(args[0].encode('utf-8')) > 1024
            or any(unicodedata.category(c) == 'Cc' for c in args[0])):
        print('Invalid app name', file=sys.stderr)
        return 1
    try:
        from gi.repository import Gio
    except ImportError:
        print('Gio unavailable', file=sys.stderr)
        return 1
    try:
        desktop_id = resolve_app(args[0], Gio.AppInfo.get_all())
    except (ValueError, TypeError, AttributeError, RuntimeError):
        print('Invalid installed-app metadata', file=sys.stderr)
        return 1
    print(json.dumps(desktop_id))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
