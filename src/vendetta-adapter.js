/* Vendetta-format adapter.
 *
 * Everything here comes from Kettu source read 2026-11-13:
 *  - src/core/vendetta/api.tsx — the `vendetta` object: `vendetta.metro`
 *    (findByProps/findByStoreName/...), `vendetta.metro.common`
 *    (FluxDispatcher, React, ReactNative, toasts, ...), `vendetta.ui`
 *    (toasts.showToast, semanticColors, ...), `vendetta.plugin.storage`
 *    (synchronous MMKV-backed object, ready in onLoad — awaited in
 *    src/core/vendetta/plugins.ts evalPlugin).
 *  - src/metro/common/types/flux.ts — Dispatcher._interceptors:
 *    ((payload) => void | boolean)[]; an interceptor returning true blocks
 *    the dispatch. This is the exact mechanism Kettu's own
 *    src/lib/api/flux/index.ts injectFluxInterceptor uses
 *    ((dispatcher._interceptors ??= []).unshift(cb), cb returning
 *    `blockedSym in payload`, i.e. true when blocked).
 *  - src/core/vendetta/plugins.ts — the plugin object is
 *    { onLoad, onUnload, settings? }, taken as ret?.default ?? ret.
 */

var api = {
    fluxIntercept: function (handler) {
        var dispatcher = null;
        try { dispatcher = vendetta.metro.common.FluxDispatcher; } catch (e) {}
        if (!dispatcher) return function () {};
        var list = dispatcher._interceptors;
        if (!list) { list = dispatcher._interceptors = []; }
        var cb = function (payload) {
            try { return handler(payload) ? true : undefined; } catch (e) { return undefined; }
        };
        list.unshift(cb);
        return function () {
            try {
                var i = list.indexOf(cb);
                if (i !== -1) list.splice(i, 1);
            } catch (e) {}
        };
    },
    storage: {
        load: function () {
            try {
                var s = vendetta.plugin.storage;
                return (s && s.log) || {};
            } catch (e) { return {}; }
        },
        save: function (entries) {
            try { if (vendetta.plugin.storage) vendetta.plugin.storage.log = entries; } catch (e) {}
        }
    },
    storageReady: null, // Vendetta storage is synchronous — nothing to await.
    showToast: function (text) {
        try { vendetta.ui.toasts.showToast(String(text)); } catch (e) {}
    },
    React: (function () { try { return vendetta.metro.common.React; } catch (e) { return null; } })(),
    ReactNative: (function () { try { return vendetta.metro.common.ReactNative; } catch (e) { return null; } })(),
    semanticColors: (function () { try { return vendetta.ui.semanticColors; } catch (e) { return null; } })()
};

var inst = createMessageLogger(api);
