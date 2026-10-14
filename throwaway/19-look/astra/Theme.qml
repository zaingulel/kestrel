pragma Singleton
import QtQuick

// Role-named values copied from the active matte-black theme at base size 14
// (colors.toml, shell.toml). Nothing here is read from the live theme.
QtObject {
  readonly property string family: "monospace"

  readonly property int caption: 12
  readonly property int bodySmall: 13
  readonly property int body: 14
  readonly property int title: 16
  readonly property int bodyLine: 21
  readonly property int captionLine: 18

  readonly property color barBackground: "#121212"
  readonly property color barText: "#bebebe"
  readonly property color barActive: "#D35F5F"
  readonly property color accent: "#e68e0d"
  readonly property color popupsBackground: "#121212"
  readonly property color popupsText: "#bebebe"
  readonly property color popupsBorder: "#e68e0d"
  readonly property color tooltipBackground: Qt.alpha("#121212", 0.97)
  readonly property color tooltipText: "#bebebe"
  readonly property color tooltipBorder: "#bebebe"

  readonly property int popupPadding: 16
  readonly property int controlGap: 9
  readonly property int labelGap: 5
  readonly property int controlHeight: 33
  readonly property int hairline: 1
  readonly property int focusStroke: 2
  readonly property int md: 7
  readonly property int barHeight: 30
  readonly property int iconSlot: 32
  readonly property int iconCanvas: 19
  readonly property int statusSlot: 25

  function barColor(kind) {
    if (kind === "listening" || kind === "speaking" || kind === "trouble") return barActive
    if (kind === "thinking") return accent
    return barText
  }

  readonly property var words: ({
    "not-running": "Not running",
    "idle": "Idle",
    "listening": "Listening",
    "thinking": "Thinking",
    "speaking": "Speaking",
    "trouble": "Brain trouble"
  })

  readonly property var tips: ({
    "not-running": "Kestrel is not running. It is not holding the microphone.",
    "idle": "Kestrel: idle. Microphone in use. Waiting for you to speak.",
    "listening": "Kestrel: listening to you. Microphone in use.",
    "thinking": "Kestrel: thinking about your message. Microphone in use.",
    "speaking": "Kestrel: speaking. Microphone in use.",
    "trouble": "Kestrel: brain trouble. A reply could not be completed. Microphone in use."
  })

  readonly property var statuses: ({
    "not-running": "Not running. Microphone released by Kestrel.",
    "idle": "Idle. Microphone in use.",
    "listening": "Listening. Microphone in use.",
    "thinking": "Thinking. Microphone in use.",
    "speaking": "Speaking. Microphone in use.",
    "trouble": "Brain trouble. Microphone in use."
  })

  readonly property var sendBlocked: ({
    "not-running": "Start Kestrel to send a message.",
    "trouble": "Resolve the brain trouble before sending."
  })
}
