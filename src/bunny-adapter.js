/* Bunny-native (Kettu) adapter.
 *
 * Everything here comes from Kettu source read 2026-11-13:
 *  - src/lib/addons/plugins/api.ts — createBunnyPluginApi: the plugin
 *    receives the `bunny` object; `bunny.plugin.createStorage()` persists
 *    to plugins/storage/<id>.json; `bunny.api.flux.intercept` is the
 *    disposable flux API (auto-disposed on stop).
 *  - src/lib/api/flux/index.ts — intercept(cb): "nullish -> nothing,
 *    falsy -> block, object -> modify". So a handler that wants to block
 *    returns FALSE here (opposite convention to the raw _interceptors
 *    array used by the Vendetta adapter — do not mix them up).
 *  - src/lib/api/storage/index.ts — createStorage returns a proxy that
 *    throws if accessed before initialisation; await it with
 *    awaitStorage(proxy) (both reachable as bunny.api.storage.* — see
 *    src/lib/api/index.ts, which re-exports the storage module, and
 *    api.ts, which spreads window.bunny.api through unchanged).
 *  - src/lib/index.ts — window.bunny.metro is @metro (findByProps etc.),
 *    window.bunny.ui is src/lib/ui (toasts.showToast).
 *  - src/lib/addons/plugins/index.ts — the file is wrapped as
 *    (bunny,definePlugin)=>{ <file>; return plugin?.default ?? plugin; }
 *    so the file must define `var plugin = { default: {...} }` with
 *    { start, stop, SettingsComponent? }.
 */

var bunnyStorage = null;
try { bunnyStorage = bunny.plugin.createStorage(); } catch (e) {}
var storageReadyFlag = false;
var storageReadyPromise = null;
try {
    storageReadyPromise = bunny.api.storage.awaitStorage(bunnyStorage);
    storageReadyPromise.then(function () { storageReadyFlag = true; }, function () {});
} catch (e) { storageReadyPromise = null; }

var api = {
    fluxIntercept: function (handler) {
        var un = null;
        try {
            un = bunny.api.flux.intercept(function (payload) {
                var block = false;
                try { block = !!handler(payload); } catch (e) {}
                return block ? false : undefined; // falsy -> block
            });
        } catch (e) {}
        return function () { try { if (un) un(); } catch (e) {} };
    },
    storage: {
        load: function () {
            try { return (storageReadyFlag && bunnyStorage && bunnyStorage.log) || {}; } catch (e) { return {}; }
        },
        save: function (entries) {
            try { if (storageReadyFlag && bunnyStorage) bunnyStorage.log = entries; } catch (e) {}
        }
    },
    storageReady: storageReadyPromise,
    showToast: function (text) {
        try { bunny.ui.toasts.showToast(String(text)); } catch (e) {}
    },
    React: (function () { try { return bunny.metro.common.React; } catch (e) { return null; } })(),
    ReactNative: (function () { try { return bunny.metro.common.ReactNative; } catch (e) { return null; } })(),
    semanticColors: null // no semanticColors on bunny.ui — core falls back to fixed colours
};

var inst = createMessageLogger(api);
