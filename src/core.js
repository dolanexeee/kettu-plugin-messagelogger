/* Shared core — Message Logger for Kettu (Vendetta-format + Bunny native).
 *
 * Keeps messages that arrive while the logger is running, so they can still
 * be read after they are deleted or edited:
 *   - MESSAGE_CREATE -> record the message (author, content, timestamp).
 *   - MESSAGE_UPDATE -> if the content changed, keep the old version in an
 *     edit history (up to 20 previous versions per message).
 *   - MESSAGE_DELETE / MESSAGE_DELETE_BULK -> mark the message deleted and
 *     BLOCK the dispatch, so the message stays visible in place in the chat
 *     instead of vanishing. A toast confirms the delete was caught.
 *
 * The `api` adapter normalises the differences between the two plugin
 * formats Kettu supports (see src/vendetta-adapter.js and
 * src/bunny-adapter.js). The core itself never touches `vendetta` or
 * `bunny` directly.
 *
 * HONEST LIMITS (same as the Discord Plus v1.1 web logger this ports):
 *   - Only messages seen while the logger is running can be kept. It CANNOT
 *     recover messages deleted before the plugin was enabled, before the
 *     app was installed, or while the app was closed.
 *   - Deleted messages stay visible but carry no red "deleted" badge on the
 *     message itself: adding one would mean patching Discord's React Native
 *     message renderer, whose component name could not be verified for
 *     Discord 353.0. The message remaining in place + the toast + the log
 *     viewer (plugin settings) is the marking.
 *   - If the channel is reloaded from the server (e.g. after a restart),
 *     kept messages disappear again — the server no longer has them.
 *
 * Logic ported from Discord Plus v1.1
 * (~/workspace/projects/discord-plus/.../plugins/messageLogger.js):
 * Flux MESSAGE_CREATE / MESSAGE_UPDATE / MESSAGE_DELETE listeners, the
 * entry shape { id, channelId, author, content, ts, edited[], deleted },
 * and the 500-entry cap. Rewritten for Metro: no webpack dispatcher
 * lookup, no DOM — Flux is reached through the Kettu/Vendetta API
 * (FluxDispatcher._interceptors / bunny.api.flux.intercept) and storage
 * through the plugin storage API instead of localStorage. */

function createMessageLogger(api) {
    "use strict";

    var MAX_ENTRIES = 500;
    var MAX_EDITS = 20;

    var log = {};            // message id -> entry (in-memory authority)
    var unintercept = null;
    var started = false;
    var saveTimer = null;

    function now() { return Date.now(); }

    function authorNameOf(msg) {
        try {
            var a = msg.author || {};
            return a.global_name || a.username || "Unknown";
        } catch (e) { return "Unknown"; }
    }

    function recordMessage(msg) {
        if (!msg || !msg.id) return null;
        var id = String(msg.id);
        var entry = log[id];
        if (!entry) {
            entry = {
                id: id,
                channelId: String(msg.channel_id || msg.channelId || ""),
                guildId: String(msg.guild_id || msg.guildId || ""),
                authorId: String((msg.author && msg.author.id) || ""),
                authorName: authorNameOf(msg),
                content: typeof msg.content === "string" ? msg.content : "",
                attachments: (msg.attachments && msg.attachments.length) || 0,
                ts: msg.timestamp ? Date.parse(msg.timestamp) : now(),
                edited: [],
                deleted: false,
                deletedAt: null
            };
            log[id] = entry;
        } else if (typeof msg.content === "string") {
            entry.content = msg.content;
        }
        return entry;
    }

    function prune() {
        var ids = Object.keys(log);
        if (ids.length <= MAX_ENTRIES) return;
        ids.sort(function (a, b) { return (log[a].ts || 0) - (log[b].ts || 0); });
        for (var i = 0; i < ids.length - MAX_ENTRIES; i++) delete log[ids[i]];
    }

    function persist() {
        // Debounced: MESSAGE_CREATE bursts (channel load) must not serialise
        // the whole log to storage on every single message.
        if (saveTimer) return;
        saveTimer = setTimeout(function () {
            saveTimer = null;
            try { prune(); api.storage.save(log); } catch (e) {}
        }, 1000);
    }

    function flush() {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        try { prune(); api.storage.save(log); } catch (e) {}
    }

    // Returns true when the dispatch should be BLOCKED.
    function handleFlux(payload) {
        if (!payload || typeof payload.type !== "string") return false;
        try {
            if (payload.type === "MESSAGE_CREATE") {
                if (payload.message) { recordMessage(payload.message); persist(); }
                return false;
            }
            if (payload.type === "MESSAGE_UPDATE") {
                var msg = payload.message;
                if (msg && msg.id) {
                    var id = String(msg.id);
                    var entry = log[id];
                    var newContent = typeof msg.content === "string" ? msg.content : "";
                    if (!entry) {
                        recordMessage(msg);
                        persist();
                    } else if (newContent !== entry.content) {
                        entry.edited.push({ content: entry.content, at: now() });
                        if (entry.edited.length > MAX_EDITS) entry.edited.shift();
                        entry.content = newContent;
                        persist();
                    }
                }
                return false;
            }
            if (payload.type === "MESSAGE_DELETE") {
                if (payload.id) {
                    var del = log[String(payload.id)];
                    if (del && !del.deleted) {
                        del.deleted = true;
                        del.deletedAt = now();
                        persist();
                        api.showToast("Deleted message kept — " + (del.authorName || "Unknown"));
                    }
                }
                return true; // block: keep the message visible in place
            }
            if (payload.type === "MESSAGE_DELETE_BULK") {
                var ids = payload.ids || [];
                var any = false;
                for (var i = 0; i < ids.length; i++) {
                    var e2 = log[String(ids[i])];
                    if (e2 && !e2.deleted) { e2.deleted = true; e2.deletedAt = now(); any = true; }
                }
                if (any) {
                    persist();
                    api.showToast(ids.length + " deleted messages kept");
                }
                return true; // block: keep the messages visible in place
            }
        } catch (e) {}
        return false;
    }

    function fmtTime(ms) {
        try {
            var d = new Date(ms);
            var p = function (n) { return (n < 10 ? "0" : "") + n; };
            return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
                " " + p(d.getHours()) + ":" + p(d.getMinutes());
        } catch (e) { return ""; }
    }

    /* --- log viewer (plugin settings page) ------------------------------ */

    function SettingsView() {
        var React = api.React;
        var RN = api.ReactNative;
        var tickState = React.useState(0);
        var tick = tickState[0];
        var setTick = tickState[1];

        var View = RN.View, Text = RN.Text, ScrollView = RN.ScrollView, Pressable = RN.Pressable;
        var colors = api.semanticColors || {};
        var textColor = colors.TEXT_NORMAL || colors.HEADER_PRIMARY || "#dbdee1";
        var mutedColor = colors.TEXT_MUTED || "#b5bac1";
        var red = "#ed4245";
        var amber = "#faa81a";

        var entries = [];
        var deletedCount = 0, editedCount = 0;
        try {
            var all = Object.keys(log).map(function (k) { return log[k]; });
            for (var i = 0; i < all.length; i++) {
                if (all[i].deleted) deletedCount++;
                if (all[i].edited && all[i].edited.length) editedCount++;
            }
            entries = all.filter(function (e) { return e.deleted || (e.edited && e.edited.length); })
                .sort(function (a, b) { return (b.deletedAt || b.ts || 0) - (a.deletedAt || a.ts || 0); });
        } catch (e) { entries = []; }

        function entryView(entry, idx) {
            var kids = [];
            var edits = entry.edited || [];
            var status = entry.deleted
                ? "Deleted"
                : "Edited (" + edits.length + ")";
            var when = fmtTime(entry.deletedAt || entry.ts);
            kids.push(React.createElement(Text, {
                key: "h",
                style: { color: entry.deleted ? red : amber, fontWeight: "700", fontSize: 13 }
            }, (entry.deleted ? "🗑️ " : "✏️ ") + status + " · " + entry.authorName + (when ? " · " + when : "")));
            var body = entry.content || (entry.attachments ? "(no text — attachment)" : "(no text)");
            kids.push(React.createElement(Text, {
                key: "c",
                style: { color: textColor, fontSize: 14, marginTop: 4 }
            }, body));
            for (var v = 0; v < edits.length; v++) {
                kids.push(React.createElement(Text, {
                    key: "v" + v,
                    style: { color: amber, fontSize: 13, marginTop: 4 }
                }, "Previous v" + (v + 1) + ": " + (edits[v].content || "(empty)")));
            }
            return React.createElement(View, {
                key: entry.id || ("e" + idx),
                style: { borderBottomWidth: 1, borderBottomColor: "#2b2d31", paddingVertical: 10 }
            }, kids);
        }

        var listKids = [];
        listKids.push(React.createElement(Text, {
            key: "title",
            style: { color: textColor, fontSize: 18, fontWeight: "700", marginBottom: 4 }
        }, "Message Logger"));
        listKids.push(React.createElement(Text, {
            key: "stats",
            style: { color: mutedColor, fontSize: 13, marginBottom: 4 }
        }, deletedCount + " deleted · " + editedCount + " edited · " + Object.keys(log).length + " tracked"));
        listKids.push(React.createElement(Text, {
            key: "note",
            style: { color: mutedColor, fontSize: 12, marginBottom: 12 }
        }, "Only messages seen while the logger is running can be kept. Deleted messages stay visible in the chat."));
        listKids.push(React.createElement(View, {
            key: "btns",
            style: { flexDirection: "row", marginBottom: 12 }
        }, [
            React.createElement(Pressable, {
                key: "refresh",
                onPress: function () { setTick(tick + 1); },
                style: { backgroundColor: "#5865f2", borderRadius: 6, paddingVertical: 8, paddingHorizontal: 14, marginRight: 8 }
            }, React.createElement(Text, { style: { color: "#fff", fontWeight: "700" } }, "Refresh")),
            React.createElement(Pressable, {
                key: "clear",
                onPress: function () {
                    log = {};
                    flush();
                    setTick(tick + 1);
                },
                style: { backgroundColor: "#4f545c", borderRadius: 6, paddingVertical: 8, paddingHorizontal: 14 }
            }, React.createElement(Text, { style: { color: "#fff", fontWeight: "700" } }, "Clear log"))
        ]));
        if (!entries.length) {
            listKids.push(React.createElement(Text, {
                key: "empty",
                style: { color: mutedColor, fontSize: 14, marginTop: 8 }
            }, "No deleted or edited messages logged yet."));
        } else {
            for (var j = 0; j < entries.length; j++) listKids.push(entryView(entries[j], j));
        }
        return React.createElement(ScrollView, { style: { flex: 1, padding: 12 } }, listKids);
    }

    function SettingsComponent() {
        if (!api.React || !api.ReactNative) return null;
        try {
            return api.React.createElement(SettingsView, null);
        } catch (e) {
            return null;
        }
    }

    /* --- lifecycle ------------------------------------------------------- */

    function start() {
        if (started) return;
        started = true;
        try { unintercept = api.fluxIntercept(handleFlux); } catch (e) { unintercept = null; }

        var mergePersisted = function () {
            try {
                var persisted = api.storage.load() || {};
                var changed = false;
                for (var id in persisted) {
                    if (Object.prototype.hasOwnProperty.call(persisted, id) && !log[id]) {
                        log[id] = persisted[id];
                        changed = true;
                    }
                }
                if (changed) flush();
            } catch (e) {}
        };

        if (api.storageReady && typeof api.storageReady.then === "function") {
            // Bunny storage initialises asynchronously — merge once ready.
            api.storageReady.then(mergePersisted, function () {});
        } else {
            // Vendetta storage is ready synchronously in onLoad.
            mergePersisted();
        }
    }

    function stop() {
        started = false;
        if (unintercept) { try { unintercept(); } catch (e) {} unintercept = null; }
        flush();
    }

    return { start: start, stop: stop, SettingsComponent: SettingsComponent };
}
