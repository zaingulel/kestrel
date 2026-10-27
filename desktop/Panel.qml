import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland
import qs.Ui
import qs.Commons

Item {
    id: root
    property var shell: null
    property var service: null
    property bool opened: false
    property bool requestedOpen: false
    property bool closingFromHost: false
    property bool closingWindow: false
    property bool pendingCloseVerification: false
    property string ownAddress: ""
    property string operation: ""
    property string nativeOutput: ""
    property string nativeError: ""
    property bool commandFailed: false

    readonly property string cleanupLua: `
        local s=_kestrelConversationPlacement
        if s then
            assert(type(s)=="table", "Kestrel panel placement failed")
            s.expected=nil; s.returnFocus=nil
            if s.openSub then s.openSub:remove(); s.openSub=nil end
            if s.closeSub then s.closeSub:remove(); s.closeSub=nil end
            if s.rule then s.rule:set_enabled(false) end
        end
    `
    readonly property string prepareLua: `
        assert(_kestrelConversationPlacement==nil or type(_kestrelConversationPlacement)=="table", "Kestrel panel placement failed")
        if not _kestrelConversationPlacement then _kestrelConversationPlacement={} end
        local s=_kestrelConversationPlacement
        local function clean()
            s.expected=nil; s.returnFocus=nil
            if s.openSub then s.openSub:remove(); s.openSub=nil end
            if s.closeSub then s.closeSub:remove(); s.closeSub=nil end
            if s.rule then s.rule:set_enabled(false) end
        end
        local ok=pcall(function()
            local allowed={rule=true,saved=true,openSub=true,closeSub=true,opened=true,failed=true,workArea=true,expected=true,returnFocus=true}
            for key,_ in pairs(s) do assert(allowed[key]) end
            local function integer(v,minimum)
                assert(type(v)=="number" and v==v and v>=minimum and v<=2147483647 and v%1==0)
                return v
            end
            local function identity(w)
                assert(type(w.address)=="string" and #w.address<=18 and w.address:match("^0x%x+$"))
                local id=w.stable_id
                assert(type(id)=="number" and id==id and id>0 and id<=9007199254740991 and id%1==0)
                return {address=w.address,stableId=id}
            end
            local function monitorBounds(m)
                assert(m and type(m.position)=="table" and type(m.size)=="table")
                local x,y=integer(m.position.x,-2147483647),integer(m.position.y,-2147483647)
                local width,height=integer(m.size.width,1),integer(m.size.height,1)
                local transform=integer(m.transform,0); assert(transform<=7)
                assert(type(m.scale)=="number" and m.scale==m.scale and m.scale>0 and m.scale<math.huge)
                if transform%2==1 then width,height=height,width end
                width,height=math.floor(width/m.scale+0.5),math.floor(height/m.scale+0.5)
                integer(width,1); integer(height,1)
                return {left=x,right=integer(x+width,-2147483647),
                    top=y,bottom=integer(y+height,-2147483647)}
            end
            assert(s.workArea==nil or type(s.workArea)=="function")
            s.workArea=function(m,gaps,border)
                local bounds=monitorBounds(m)
                assert(type(m.reserved)=="table" and type(gaps)=="table")
                integer(border,0)
                for _,edge in ipairs({"top","right","bottom","left"}) do
                    integer(m.reserved[edge],0); integer(gaps[edge],0)
                end
                local area={left=bounds.left+m.reserved.left+gaps.left+border,
                    right=bounds.right-m.reserved.right-gaps.right-border,
                    top=bounds.top+m.reserved.top+gaps.top+border,
                    bottom=bounds.bottom-m.reserved.bottom-gaps.bottom-border}
                for _,v in pairs(area) do integer(v,-2147483647) end
                assert(area.right-area.left>=448 and area.bottom-area.top>=640)
                return area
            end
            if s.rule then assert(type(s.rule)=="userdata") end
            clean()
            if not s.rule then
                s.rule=hl.window_rule({name="kestrel-conversation-placement",enabled=true,
                    match={initial_title="^Kestrel conversation$",initial_class="^org[.]quickshell$"},
                    float=true,size={448,640},no_anim=true})
            end
            local function areaFor(m)
                local gaps,gapError=hl.get_config("general.gaps_out")
                local border,borderError=hl.get_config("general.border_size")
                assert(gapError==nil and borderError==nil)
                return s.workArea(m,gaps,border)
            end
            local prior=hl.get_active_window()
            if prior then s.returnFocus=identity(prior) end
            local monitor,focused
            local monitors=hl.get_monitors(); assert(type(monitors)=="table")
            if s.saved then
                assert(type(s.saved)=="table" and type(s.saved.monitor)=="string" and #s.saved.monitor>0)
                integer(s.saved.xLocal,-2147483647); integer(s.saved.yLocal,-2147483647)
                assert(type(s.saved.area)=="table")
                for _,edge in ipairs({"left","right","top","bottom"}) do integer(s.saved.area[edge],-2147483647) end
            end
            for _,m in ipairs(monitors) do
                assert(type(m.name)=="string" and #m.name>0 and type(m.focused)=="boolean")
                if m.focused then focused=m end
                if s.saved and m.name==s.saved.monitor then monitor=m end
            end
            monitor=monitor or focused; assert(monitor)
            local area=areaFor(monitor)
            local x,y=area.right-448,area.bottom-640
            if s.saved then
                x=monitor.position.x+s.saved.xLocal; y=monitor.position.y+s.saved.yLocal
                local same=monitor.name==s.saved.monitor
                for _,edge in ipairs({"left","right"}) do same=same and area[edge]-monitor.position.x==s.saved.area[edge] end
                for _,edge in ipairs({"top","bottom"}) do same=same and area[edge]-monitor.position.y==s.saved.area[edge] end
                local visible=false
                for _,m in ipairs(monitors) do
                    local bounds=monitorBounds(m)
                    visible=visible or (x<bounds.right and x+448>bounds.left
                        and y<bounds.bottom and y+640>bounds.top)
                end
                if not same or not visible then
                    x=math.max(area.left,math.min(area.right-448,x))
                    y=math.max(area.top,math.min(area.bottom-640,y))
                end
            end
            integer(x,-2147483647); integer(y,-2147483647)
            s.expected={monitor=monitor.name,x=x,y=y}
            s.opened=false; s.failed=false; s.rule:set_enabled(true)
            s.closeSub=hl.on("window.close",function(w)
                if w.initial_title~="Kestrel conversation" or w.initial_class~="org.quickshell" then return end
                local captured=pcall(function()
                    local m=w.monitor; local a=areaFor(m)
                    local at=w.at
                    integer(at.x,-2147483647); integer(at.y,-2147483647)
                    s.saved={monitor=m.name,xLocal=at.x-m.position.x,yLocal=at.y-m.position.y,
                        area={left=a.left-m.position.x,right=a.right-m.position.x,
                            top=a.top-m.position.y,bottom=a.bottom-m.position.y}}
                end)
                local restored=pcall(function()
                    local a=hl.get_active_window()
                    if s.returnFocus and a and a.address==w.address and a.stable_id==w.stable_id then
                        for _,p in ipairs(hl.get_windows()) do
                            if p.address==s.returnFocus.address and p.stable_id==s.returnFocus.stableId then
                                hl.dispatch(hl.dsp.focus({window=p})); break
                            end
                        end
                    end
                end)
                clean(); s.opened=false
                if not captured or not restored then s.failed=true; error("Kestrel panel placement failed") end
            end)
            s.openSub=hl.on("window.open",function(w)
                if w.initial_title~="Kestrel conversation" or w.initial_class~="org.quickshell" then return end
                local moved=pcall(function()
                    hl.dispatch(hl.dsp.window.move({window=w,monitor=monitor,follow=true}))
                    hl.dispatch(hl.dsp.window.move({window=w,x=x,y=y,relative=false}))
                    assert(w.monitor.name==monitor.name and w.at.x==x and w.at.y==y and w.size.x==448 and w.size.y==640)
                    s.opened=true
                end)
                if s.openSub then s.openSub:remove(); s.openSub=nil end
                if not moved then clean(); s.failed=true; error("Kestrel panel placement failed") end
            end)
            assert(s.openSub:is_active() and s.closeSub:is_active())
        end)
        if not ok then clean(); s.failed=true; error("Kestrel panel placement failed") end
    `
    readonly property string verifyOpenLua: `
        local s=_kestrelConversationPlacement
        assert(type(s)=="table" and s.opened==true and s.failed==false and s.openSub==nil,
            "Kestrel panel placement failed")
        local e=s.expected
        assert(type(e)=="table" and type(e.monitor)=="string" and #e.monitor>0,
            "Kestrel panel placement failed")
        for _,key in ipairs({"x","y"}) do
            local v=e[key]
            assert(type(v)=="number" and v==v and v>=-2147483647 and v<=2147483647 and v%1==0,
                "Kestrel panel placement failed")
        end
        local windows=hl.get_windows()
        assert(type(windows)=="table", "Kestrel panel placement failed")
        local count=0
        for _,w in ipairs(windows) do
            if w.initial_title=="Kestrel conversation" and w.initial_class=="org.quickshell" then
                count=count+1
                assert(w.monitor.name==e.monitor and w.at.x==e.x and w.at.y==e.y
                    and w.size.x==448 and w.size.y==640, "Kestrel panel placement failed")
            end
        end
        assert(count==1, "Kestrel panel placement failed")
    `
    readonly property string verifyCloseLua: `
        local s=_kestrelConversationPlacement
        assert(s==nil or (type(s)=="table" and type(s.saved)=="table" and s.failed==false
            and s.openSub==nil and s.closeSub==nil and not s.rule:is_enabled()),
            "Kestrel panel placement failed")
    `

    function runNative(stage, command) {
        operation = stage
        nativeOutput = ""
        nativeError = ""
        commandFailed = false
        placement.command = command
        placement.running = true
    }

    function open(payloadJson) {
        requestedOpen = true
        closingFromHost = false
        if (operation !== "" || window.visible || closingWindow) return
        watchdog.restart()
        runNative("baseline", ["/usr/bin/hyprctl", "configerrors"])
    }

    function close() {
        requestedOpen = false
        if (window.visible || ownAddress !== "") closingWindow = true
        opened = false
        closingFromHost = true
        window.visible = false
        closingFromHost = false
        if (operation === "await-open" && ownAddress === "" && !pendingCloseVerification) {
            watchdog.restart()
            runNative("cleanup", ["/usr/bin/hyprctl", "eval", cleanupLua])
        } else if (operation === "" || operation === "await-open" || operation === "await-close") {
            finishOperation()
        }
    }

    function requestClose() {
        close()
        if (shell) shell.hide("local.kestrel")
    }

    function finishOperation() {
        operation = ""
        watchdog.stop()
        if (pendingCloseVerification) {
            pendingCloseVerification = false
            watchdog.restart()
            runNative("verify-close", ["/usr/bin/hyprctl", "eval", verifyCloseLua])
        } else if (closingWindow && ownAddress !== "") {
            operation = "await-close"
            watchdog.restart()
        } else if (requestedOpen && !window.visible && !closingWindow) {
            open("{}")
        }
    }

    function finishCleanup(success) {
        if (!success && service && service.placementAdvisory === "") service.setPlacementFailure(true)
        closingWindow = false
        ownAddress = ""
        pendingCloseVerification = false
        finishOperation()
    }

    function failPlacement(reason) {
        watchdog.stop()
        if (operation === "cleanup" || operation === "cleanup-errors") {
            operation = "cleanup-stopped"
            commandFailed = true
            placement.running = false
            placement.signal(9)
            return
        }
        if (service) service.setPlacementFailure(true, reason)
        requestedOpen = false
        if (window.visible || ownAddress !== "") closingWindow = true
        opened = false
        closingFromHost = true
        window.visible = false
        closingFromHost = false
        if (placement.running) {
            commandFailed = true
            placement.running = false
            placement.signal(9)
        } else {
            watchdog.restart()
            runNative("cleanup", ["/usr/bin/hyprctl", "eval", cleanupLua])
        }
        if (shell) shell.hide("local.kestrel")
    }

    function commandFinished(success) {
        const stage = operation
        if (stage === "cleanup-stopped") { finishCleanup(false); return }
        const output = nativeOutput.trim()
        if (stage === "cleanup" || stage === "cleanup-errors") {
            if (!success || commandFailed || output !== (stage === "cleanup" ? "ok" : "")) {
                finishCleanup(false)
            } else if (stage === "cleanup") {
                runNative("cleanup-errors", ["/usr/bin/hyprctl", "configerrors"])
            } else {
                finishCleanup(true)
            }
            return
        }
        if (commandFailed) {
            watchdog.restart()
            runNative("cleanup", ["/usr/bin/hyprctl", "eval", cleanupLua])
            return
        }
        if (stage === "verify-open" && closingWindow) {
            finishOperation()
            return
        }
        if (!success) {
            operation = ""
            failPlacement()
            return
        }
        if (stage === "baseline") {
            if (output !== "") { failPlacement("configuration"); return }
            runNative("prepare", ["/usr/bin/hyprctl", "eval", prepareLua])
        } else if (stage === "prepare" || stage === "verify-open" || stage === "verify-close") {
            if (output !== "ok") { failPlacement(); return }
            runNative(stage + "-errors", ["/usr/bin/hyprctl", "configerrors"])
        } else {
            if (output !== "") { failPlacement(); return }
            if (stage === "prepare-errors") {
                if (!requestedOpen) {
                    runNative("cleanup", ["/usr/bin/hyprctl", "eval", cleanupLua])
                    return
                }
                operation = "await-open"
                opened = true
                window.visible = true
                Qt.callLater(function() { if (root.requestedOpen) content.focusComposer() })
            } else {
                if (stage === "verify-open-errors" && requestedOpen) {
                    opened = true
                    if (service) service.setPlacementFailure(false)
                }
                if (stage === "verify-close-errors") closingWindow = false
                finishOperation()
            }
        }
    }

    Connections {
        target: Hyprland
        function onRawEvent(event) {
            if (event.name === "openwindow") {
                const fields = event.parse(4)
                if (fields.length !== 4 || fields[2] !== "org.quickshell" || fields[3] !== "Kestrel conversation") return
                if (!/^[0-9a-fA-F]{1,16}$/.test(fields[0])) return
                root.ownAddress = fields[0]
                if (root.operation === "await-open" && root.requestedOpen)
                    root.runNative("verify-open", ["/usr/bin/hyprctl", "eval", root.verifyOpenLua])
            } else if (event.name === "closewindow" && root.ownAddress !== "" && event.data === root.ownAddress) {
                const ownedClose = root.closingWindow
                root.ownAddress = ""
                root.closingWindow = true
                root.opened = false
                root.pendingCloseVerification = true
                if (!ownedClose) {
                    root.requestedOpen = false
                    if (root.shell) root.shell.hide("local.kestrel")
                }
                if (root.operation === "" || root.operation === "await-open" || root.operation === "await-close") root.finishOperation()
            }
        }
    }
    Process {
        id: placement
        stdout: SplitParser {
            splitMarker: ""
            onRead: function(data) {
                if (root.commandFailed) return
                if (data.length > 4096 - root.nativeOutput.length) root.failPlacement()
                else root.nativeOutput += data
            }
        }
        stderr: SplitParser {
            splitMarker: ""
            onRead: function(data) {
                if (root.commandFailed) return
                if (data.length > 4096 - root.nativeError.length) root.failPlacement()
                else root.nativeError += data
            }
        }
        onExited: function(exitCode, exitStatus) { root.commandFinished(exitCode === 0 && exitStatus === 0) }
    }
    Timer { id: watchdog; interval: 1000; onTriggered: root.failPlacement() }
    Component { id: nativeGlyph; OpticalGlyph {} }
    Component { id: nativeTooltip; PanelToolTip {} }
    FloatingWindow {
        id: window
        title: "Kestrel conversation"
        visible: false
        implicitWidth: 448
        implicitHeight: 640
        minimumSize: Qt.size(448, 640)
        maximumSize: Qt.size(448, 640)
        color: Color.popups.background
        onClosed: {
            root.opened = false
            if (!root.closingWindow) {
                root.requestedOpen = false
                if (!root.closingFromHost && root.shell) root.shell.hide("local.kestrel")
            }
        }
        Conversation {
            id: content
            service: root.service
            anchors.fill: parent
            background: Color.popups.background
            flatBackground: {
                const flat = Color.flatColor(Color.pick("popups.background", Color.background), Color.background)
                return Qt.rgba(flat.r, flat.g, flat.b, 1)
            }
            glyphComponent: nativeGlyph
            tooltipComponent: nativeTooltip
            conversationAvailable: root.service ? root.service.conversationAvailable : false
            ink: Color.flatColor(Color.pick("popups.text", Color.foreground), Color.foreground)
            accentInk: Color.accent
            troubleInk: Color.flatColor(Color.pick("bar.active", Color.urgent), Color.urgent)
            currentState: root.service ? root.service.state : "unavailable"
            statusSentence: root.service ? root.service.statusSentence : "Status unavailable. Microphone use unknown."
            motionEnabled: root.service ? root.service.motionEnabled : false
            turns: root.service ? root.service.turns : []
            conversationSession: root.service ? root.service.conversationSession : ""
            announcementsEnabled: window.visible && root.opened
            conversationMessage: root.service ? root.service.conversationMessage : "Conversation unavailable. Reopen the panel."
            placementAdvisory: root.service ? root.service.placementAdvisory : ""
            troubleAdvisory: root.service ? root.service.troubleAdvisory : ""
            brainNotice: root.service ? root.service.brainNotice : ""
            // The host scale is relative to base size 12; the panel tokens are set at base size 14.
            textScale: Style.fontScale * 12 / 14
            onCloseRequested: root.requestClose()
        }
    }
    Component.onDestruction: {
        watchdog.stop()
        placement.running = false
    }
}
