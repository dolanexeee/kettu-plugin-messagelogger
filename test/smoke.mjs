// Smoke test for the generated plugin files — no iPhone needed.
// Simulates Kettu's two loaders (Vendetta eval + Bunny wrapper) with mock
// `vendetta` / `bunny` objects, then drives Flux payloads through the
// plugin and asserts the core behaviour: record, edit history, delete
// blocking, bulk delete, storage persistence, settings render, unload.
//
//   node test/smoke.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, fn) {
    try { fn(); console.log("  ok:", name); }
    catch (e) { failures++; console.log("  FAIL:", name, "->", e.message); }
}

function makeReact() {
    return {
        createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
        useState: (init) => [init, () => {}]
    };
}
const RN = { View: "View", Text: "Text", ScrollView: "ScrollView", Pressable: "Pressable" };

// Render a component element produced by the mock createElement: call the
// function component to get its rendered tree.
function render(el) {
    if (el && typeof el.type === "function") return el.type();
    return el;
}

// ---------------------------------------------------------------- Vendetta
console.log("Vendetta format (index.js):");
{
    const js = read("index.js");
    const toasts = [];
    const storage = {};
    const dispatcher = { _interceptors: [] };
    const vendetta = {
        metro: { common: {
            FluxDispatcher: dispatcher,
            React: makeReact(),
            ReactNative: RN,
            toasts: { open: (o) => toasts.push(o.content) }
        } },
        ui: {
            toasts: { showToast: (t) => toasts.push(t) },
            semanticColors: { TEXT_NORMAL: "#fff", TEXT_MUTED: "#aaa" }
        },
        plugin: { storage }
    };
    // Kettu evalPlugin: vendetta => { return <js> }  (src/core/vendetta/plugins.ts)
    const ret = (0, eval)(`vendetta=>{return ${js}}`)(vendetta);
    const plugin = ret?.default ?? ret;
    check("exports { onLoad, onUnload, settings }", () => {
        assert.equal(typeof plugin.onLoad, "function");
        assert.equal(typeof plugin.onUnload, "function");
        assert.equal(typeof plugin.settings, "function");
    });
    plugin.onLoad();
    check("interceptor registered on FluxDispatcher", () => {
        assert.equal(dispatcher._interceptors.length, 1);
    });
    const intercept = (payload) => dispatcher._interceptors[0](payload);

    check("MESSAGE_CREATE passes through unblocked", () => {
        assert.equal(intercept({ type: "MESSAGE_CREATE", message: {
            id: "1001", channel_id: "2001", author: { id: "3001", username: "alice" },
            content: "hello world", timestamp: "2026-11-13T10:00:00.000Z"
        } }), undefined);
    });
    check("MESSAGE_UPDATE with new content passes through unblocked", () => {
        assert.equal(intercept({ type: "MESSAGE_UPDATE", message: {
            id: "1001", channel_id: "2001", author: { id: "3001", username: "alice" },
            content: "hello edited world", timestamp: "2026-11-13T10:01:00.000Z"
        } }), undefined);
    });
    check("MESSAGE_UPDATE with identical content passes through", () => {
        assert.equal(intercept({ type: "MESSAGE_UPDATE", message: { id: "1001", content: "hello edited world" } }), undefined);
    });
    check("MESSAGE_DELETE is BLOCKED (returns true) and toasts", () => {
        assert.equal(intercept({ type: "MESSAGE_DELETE", id: "1001", channelId: "2001" }), true);
        assert.ok(toasts.some((t) => t.includes("alice") || t.includes("Deleted")));
    });
    check("MESSAGE_DELETE_BULK is BLOCKED (returns true)", () => {
        intercept({ type: "MESSAGE_CREATE", message: { id: "1002", channel_id: "2001", author: { username: "bob" }, content: "second", timestamp: "2026-11-13T10:02:00.000Z" } });
        intercept({ type: "MESSAGE_CREATE", message: { id: "1003", channel_id: "2001", author: { username: "carol" }, content: "third", timestamp: "2026-11-13T10:03:00.000Z" } });
        assert.equal(intercept({ type: "MESSAGE_DELETE_BULK", ids: ["1002", "1003"], channelId: "2001" }), true);
    });
    check("unrelated dispatch passes through unblocked (not true)", () => {
        assert.notEqual(intercept({ type: "TYPING_START", userId: "3001" }), true);
    });

    // Persistence is debounced (1s) — wait for the flush, then check storage.
    await sleep(1300);
    check("storage: CREATE recorded with author + content", () => {
        assert.equal(storage.log["1001"].content, "hello edited world");
        assert.equal(storage.log["1001"].authorName, "alice");
    });
    check("storage: edit history kept the previous version", () => {
        assert.equal(storage.log["1001"].edited.length, 1);
        assert.equal(storage.log["1001"].edited[0].content, "hello world");
    });
    check("storage: deleted flags set", () => {
        assert.equal(storage.log["1001"].deleted, true);
        assert.equal(storage.log["1002"].deleted, true);
        assert.equal(storage.log["1003"].deleted, true);
    });
    check("settings component renders current + previous content", () => {
        const flat = JSON.stringify(render(plugin.settings()));
        assert.ok(flat.includes("hello edited world"), "current content missing");
        assert.ok(flat.includes("hello world"), "previous version missing");
        assert.ok(flat.includes("Deleted"), "deleted marker missing");
    });
    check("onUnload removes the interceptor", () => {
        plugin.onUnload();
        assert.equal(dispatcher._interceptors.length, 0);
    });
}

// ------------------------------------------------------------------- Bunny
console.log("Bunny-native format (builds/messagelogger/index.js):");
{
    const js = read("builds/messagelogger/index.js");
    const toasts = [];
    const store = { data: {} };
    let interceptCb = null;
    const bunny = {
        metro: { common: { React: makeReact(), ReactNative: RN } },
        api: {
            flux: { intercept: (cb) => { interceptCb = cb; return () => { interceptCb = null; }; } },
            storage: { awaitStorage: () => Promise.resolve() }
        },
        ui: { toasts: { showToast: (t) => toasts.push(t) } },
        plugin: {
            createStorage: () => new Proxy(store.data, {
                get: (t, p) => t[p],
                set: (t, p, v) => { t[p] = v; return true; }
            })
        }
    };
    // Kettu startPlugin wrapper: (bunny,definePlugin)=>{ <file>; return plugin?.default ?? plugin; }
    const instantiator = (0, eval)(`(bunny,definePlugin)=>{${js};return plugin?.default ?? plugin;}`);
    const plugin = instantiator(bunny, (p) => p);
    check("exports { start, stop, SettingsComponent }", () => {
        assert.equal(typeof plugin.start, "function");
        assert.equal(typeof plugin.stop, "function");
        assert.equal(typeof plugin.SettingsComponent, "function");
    });
    plugin.start();
    check("flux intercept registered via bunny.api.flux.intercept", () => {
        assert.equal(typeof interceptCb, "function");
    });
    // bunny.api.flux.intercept convention: falsy return -> block (src/lib/api/flux/index.ts)
    const dispatch = (payload) => interceptCb(payload);
    check("MESSAGE_CREATE returns undefined (no block)", () => {
        assert.equal(dispatch({ type: "MESSAGE_CREATE", message: {
            id: "9001", channel_id: "8001", author: { username: "dave" },
            content: "bunny test", timestamp: "2026-11-13T10:05:00.000Z"
        } }), undefined);
    });
    check("MESSAGE_DELETE returns false (block) in Bunny convention + toasts", () => {
        assert.equal(dispatch({ type: "MESSAGE_DELETE", id: "9001", channelId: "8001" }), false);
        assert.ok(toasts.some((t) => t.includes("dave")));
    });
    check("settings component renders the deleted entry", () => {
        assert.ok(JSON.stringify(render(plugin.SettingsComponent())).includes("bunny test"));
    });
    check("stop() removes the intercept", () => {
        plugin.stop();
        assert.equal(interceptCb, null);
    });
}

console.log(failures === 0 ? "\nAll smoke checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
