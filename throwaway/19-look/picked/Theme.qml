pragma Singleton
import QtQuick
import Quickshell
import Quickshell.Io

// Sizes are copied from matte-black at base size 14. Every colour is read from the Omarchy theme directory
// (colors.toml, then shell.toml on top), mirroring /usr/share/omarchy/shell/Commons/Color.qml for the roles
// used here. The hex values on the four raw colours are only what shows before the files load.
QtObject {
  id: root

  readonly property string family: "monospace"

  readonly property int caption: 12
  readonly property int bodySmall: 13
  readonly property int body: 14
  readonly property int title: 16
  readonly property int bodyLine: 21
  readonly property int captionLine: 18

  readonly property int popupPadding: 16
  readonly property int controlGap: 9
  readonly property int labelGap: 5
  readonly property int controlHeight: 33
  readonly property int hairline: 1
  readonly property int focusStroke: 2
  readonly property int barHeight: 30
  readonly property int iconSlot: 32
  readonly property int iconCanvas: 19
  readonly property int slotWidth: 25

  // "current" reads the live theme; a stock theme name reads that theme's folder instead.
  property string themeName: "current"
  readonly property string stateHome: Quickshell.env("HOME") + "/.local/state"
  readonly property string themeDir: themeName === "current"
    ? stateHome + "/omarchy/current/theme"
    : "/usr/share/omarchy/themes/" + themeName

  property color foreground: "#cacccc"
  property color background: "#101315"
  property color accent: "#cacccc"
  property color urgent: "#a55555"

  // Flat "section.key" -> raw string from shell.toml. Reassigned whole so the role bindings re-evaluate.
  property var shellValues: ({})

  readonly property color barBackground: composed("bar.background", "bar.background-alpha", background, 1.0)
  readonly property color barText: role("bar.text", foreground)
  readonly property color barActive: role("bar.active", urgent)
  readonly property color popupsBackground: composed("popups.background", "popups.background-alpha", background, 1.0)
  readonly property color popupsText: role("popups.text", foreground)
  readonly property color tooltipBackground: composed("tooltip.background", "tooltip.background-alpha", background, 1.0)
  readonly property color tooltipText: role("tooltip.text", foreground)
  readonly property color tooltipBorder: composed("tooltip.border", "tooltip.border-alpha", foreground, 1.0)
  readonly property color barTextResting: Qt.alpha(barText, 0.6)

  function pick(key, fallback) {
    var v = shellValues[key]
    return (typeof v === "string" && v.length > 0) ? v : fallback
  }

  function pickAlpha(key, fallback) {
    var v = shellValues[key]
    if (typeof v !== "string" || v.length === 0) return fallback
    var n = Number(v)
    return isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback
  }

  // A shell.toml value is a hex colour or the name of another role.
  function flatColor(value, fallback) {
    var token = String(value || "").replace(/^\s+|\s+$/g, "")
    var name = token.toLowerCase()
    if (shellValues[name] && shellValues[name] !== token) return flatColor(shellValues[name], fallback)
    if (name === "foreground" || name === "text") return foreground
    if (name === "accent") return accent
    if (name === "urgent") return urgent
    if (name === "background") return background
    return /^#[0-9A-Fa-f]{6}$/.test(token) ? token : fallback
  }

  function role(key, fallback) {
    return flatColor(pick(key, fallback), fallback)
  }

  function composed(colorKey, alphaKey, colorFallback, alphaFallback) {
    return Qt.alpha(role(colorKey, colorFallback), pickAlpha(alphaKey, alphaFallback))
  }

  function loadColors(raw) {
    var lines = String(raw || "").split("\n")
    var foundAccent = false
    var loadedForeground = false
    var loadedBackground = false
    var color0 = ""
    var color4 = ""
    var color7 = ""
    for (var i = 0; i < lines.length; i++) {
      var match = lines[i].match(/^\s*([A-Za-z0-9_-]+)\s*=\s*["']?(#[0-9A-Fa-f]{6})/)
      if (!match) continue
      if (match[1] === "foreground") { foreground = match[2]; loadedForeground = true }
      else if (match[1] === "background") { background = match[2]; loadedBackground = true }
      else if (match[1] === "accent") { accent = match[2]; foundAccent = true }
      else if (match[1] === "color0") color0 = match[2]
      else if (match[1] === "color4") color4 = match[2]
      else if (match[1] === "color7") color7 = match[2]
      else if (match[1] === "red" || match[1] === "color1") urgent = match[2]
    }
    if (!loadedBackground && color0.length > 0) background = color0
    if (!loadedForeground && color7.length > 0) foreground = color7
    if (!foundAccent && color4.length > 0) accent = color4
  }

  // Quoted strings, bare numbers and bare role names under [section] headers, with inline comments.
  function loadShell(raw) {
    var parsed = {}
    var lines = String(raw || "").split("\n")
    var section = ""
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/^\s+|\s+$/g, "")
      if (!line || line.charAt(0) === "#") continue
      var sectionMatch = line.match(/^\[([A-Za-z0-9_-]+)\]\s*(#.*)?$/)
      if (sectionMatch) { section = sectionMatch[1]; continue }
      var kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*["']([^"']+)["']\s*(#.*)?$/)
        || line.match(/^([A-Za-z0-9_-]+)\s*=\s*(-?\d+(?:\.\d+)?)\s*(#.*)?$/)
        || line.match(/^([A-Za-z0-9_-]+)\s*=\s*([A-Za-z][A-Za-z0-9_-]*)\s*(#.*)?$/)
      if (kv && section) parsed[section + "." + kv[1]] = kv[2]
    }
    shellValues = parsed
  }

  // A theme switch deletes the theme folder and moves a new one in, which ends a watch on the files inside it.
  // theme.name sits beside the folder and is rewritten after the move, so its change reloads both files.
  property FileView colorsFile: FileView {
    path: root.themeDir + "/colors.toml"
    watchChanges: true
    printErrors: false
    onLoaded: root.loadColors(text())
    onFileChanged: reload()
  }
  property FileView shellFile: FileView {
    path: root.themeDir + "/shell.toml"
    watchChanges: true
    printErrors: false
    onLoaded: root.loadShell(text())
    onLoadFailed: root.loadShell("")
    onFileChanged: reload()
  }
  property FileView nameFile: FileView {
    path: root.stateHome + "/omarchy/current/theme.name"
    watchChanges: true
    printErrors: false
    onFileChanged: { root.colorsFile.reload(); root.shellFile.reload() }
  }

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
