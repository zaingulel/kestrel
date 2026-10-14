pragma Singleton
import QtQuick

// Role-named values copied from the active matte-black theme at base size 14
// (colors.toml, shell.toml). Nothing here is read from the live theme.
QtObject {
  readonly property string family: "monospace"

  readonly property int caption: 12
  readonly property int bodySmall: 13
  readonly property int body: 14
  readonly property int heading: 19

  readonly property color text: "#bebebe"
  readonly property color lightForeground: "#8a8a8d"
  readonly property color active: "#D35F5F"
  readonly property color accent: "#e68e0d"
  readonly property color background: "#121212"
  readonly property color lighterBackground: "#1e1e1e"
  readonly property color muted: "#333333"
  readonly property color controlBorder: Qt.alpha("#bebebe", 0.4)
  readonly property color tooltipBackground: Qt.alpha("#121212", 0.97)

  readonly property int barHeight: 30
  readonly property int slotWidth: 25

  readonly property var tips: ({
    "not-running": "Kestrel is not running",
    "idle": "Kestrel is idle",
    "listening": "Listening",
    "thinking": "Thinking",
    "speaking": "Speaking",
    "trouble": "The brain is unreachable"
  })

  readonly property var words: ({
    "listening": "listening",
    "thinking": "thinking",
    "speaking": "speaking",
    "trouble": "brain unreachable"
  })
}
