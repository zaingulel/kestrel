// Throwaway prototype for card #19 (the owner's pick). Question it answers: put together, do Claude's Indicator A
// "three marks" with its amended resting states and Astra's Panel A "narrow conversation" look right at real size in
// the live Omarchy theme, with the panel opening at the bottom right and a click on the indicator toggling it?
//
//   quickshell -p throwaway/19-look/picked
//   quickshell ipc -p throwaway/19-look/picked call proto state not-running|idle|listening|thinking|speaking|trouble
//   quickshell ipc -p throwaway/19-look/picked call proto sheet on|off
//   quickshell ipc -p throwaway/19-look/picked call proto panel open|closed
//   quickshell ipc -p throwaway/19-look/picked call proto view conversation|empty
//   quickshell ipc -p throwaway/19-look/picked call proto theme current|<stock theme name>
//
// Delete with the job; nothing here reaches main.
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import QtQuick
import Qt.labs.folderlistmodel

ShellRoot {
  id: root

  property string stateName: "idle"
  property bool sheetOn: false
  property bool panelOpen: false
  property string viewName: "conversation"

  readonly property var stateNames: ["not-running", "idle", "listening", "thinking", "speaking", "trouble"]

  // The scripted exchange; the state decides how much of it the panel shows.
  readonly property var first: ({ who: "you", text: "Here’s the reference I’m looking at: https://hypr.land/. What’s the difference between floating and tiled windows?" })
  readonly property var firstReply: ({ who: "kestrel", text: "Tiled windows share the available space. A floating window sits above them and can be moved independently.", sourceLabel: "Reference you shared: hypr.land", sourceUrl: "https://hypr.land/" })
  readonly property var second: ({ who: "you", text: "So I can move this panel without shifting my editor?" })
  readonly property var secondReply: ({ who: "kestrel", text: "Yes. Hold Super and drag it with the left mouse button." })
  readonly property string partialReply: "Yes. Hold Super and drag it"

  readonly property var turns: {
    if (viewName === "empty") return []
    if (stateName === "listening")
      return [first, firstReply, { who: "you", text: "Listening. Words appear after a pause." }]
    if (stateName === "thinking")
      return [first, firstReply, second, { who: "kestrel", text: "Thinking..." }]
    if (stateName === "speaking")
      return [first, firstReply, second, { who: "kestrel", text: partialReply, speaking: true }]
    if (stateName === "trouble")
      return [first, firstReply, second, { who: "kestrel", text: partialReply, incomplete: true }]
    return [first, firstReply, second, secondReply]
  }

  FolderListModel {
    id: stockThemes
    folder: "file:///usr/share/omarchy/themes"
    showFiles: false
  }

  function isStockTheme(name) {
    for (let i = 0; i < stockThemes.count; i++)
      if (stockThemes.get(i, "fileName") === name) return true
    return false
  }

  IpcHandler {
    target: "proto"

    function state(name: string): void {
      if (root.stateNames.indexOf(name) !== -1) root.stateName = name
    }

    function sheet(mode: string): void {
      if (mode === "on" || mode === "off") root.sheetOn = mode === "on"
    }

    function panel(mode: string): void {
      if (mode === "open" || mode === "closed") root.panelOpen = mode === "open"
    }

    function view(name: string): void {
      if (name === "conversation" || name === "empty") root.viewName = name
    }

    function theme(name: string): void {
      if (name === "current" || root.isStockTheme(name)) Theme.themeName = name
    }
  }

  PanelWindow {
    anchors { top: true; left: true; right: true }
    margins.top: Theme.barHeight
    exclusionMode: ExclusionMode.Ignore
    implicitHeight: root.sheetOn ? Theme.barHeight * root.stateNames.length : Theme.barHeight
    color: Theme.barBackground
    WlrLayershell.layer: WlrLayer.Top
    WlrLayershell.namespace: "kestrel-proto-strip"

    Column {
      anchors.fill: parent

      BarRow {
        visible: !root.sheetOn
        width: parent.width
        kind: root.stateName
        onActivated: root.panelOpen = !root.panelOpen
      }

      Repeater {
        model: root.stateNames

        BarRow {
          required property string modelData
          visible: root.sheetOn
          width: parent.width
          kind: modelData
          label: modelData
          onActivated: root.panelOpen = !root.panelOpen
        }
      }
    }
  }

  PanelA {
    visible: root.panelOpen
    turns: root.turns
    stateName: root.stateName
    onCloseRequested: root.panelOpen = false
  }
}
