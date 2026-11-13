# Message Logger — Kettu plugin for iOS

Keeps deleted and edited messages visible in Discord on iOS (Kettu / KettuTweak, Discord 353.0). Part of the **Kettu MAX** build. Ported from Discord Plus v1.1's Message Logger — rewritten for Metro/Hermes (no webpack, no DOM).

## Install

**Primary — Vendetta format (recommended):** in Kettu, **Settings → Plugins → Install a plugin**, paste this URL:

```
https://dolanexeee.github.io/kettu-plugin-messagelogger/
```

Kettu fetches `manifest.json`, then `index.js` from that folder. If Kettu warns the source is unproxied, tap Continue — this is our own repo.

**Secondary — Bunny-native format:** add this repository URL in Kettu's plugin repositories (same URL — this repo also serves `repo.json` + `builds/messagelogger/`):

```
https://dolanexeee.github.io/kettu-plugin-messagelogger/
```

## What it does

- **Deleted messages stay visible in place.** When a message is deleted, the plugin blocks the `MESSAGE_DELETE` dispatch, so the message remains in the chat instead of vanishing. A toast ("Deleted message kept — \<author\>") confirms the catch.
- **Edit history.** When a message is edited, the previous version is kept (up to 20 versions per message).
- **Log viewer.** Open the plugin's settings page to see all deleted/edited messages with author, time, current content and previous versions — plus Refresh and Clear log. Up to 500 messages are kept, persisted across restarts.
- **Bulk deletes** (`MESSAGE_DELETE_BULK`) are blocked the same way.

## Honest limits

- **Only messages seen while the logger is running can be kept.** It cannot recover messages deleted before the plugin was enabled, before the app was installed, or while the app was closed.
- **No red "deleted" badge on the message itself.** Deleted messages stay visible, but marking them in the message row would mean patching Discord's React Native message renderer, whose component name could not be verified for Discord 353.0 — so the plugin does not guess one. The message remaining in place + the toast + the log viewer is the marking.
- **Server reload clears kept messages.** If a channel is re-fetched from the server (e.g. after an app restart), kept messages disappear again — the server no longer has them.
- **Not yet tested on-device.** Syntax-checked (`node --check`) and behaviour-tested with a mock Flux dispatcher (see `test/smoke.mjs` — 19 checks, all passing), but no iPhone was available here. If a Flux payload shape differs on Discord 353.0, the plugin fails safe: every handler is wrapped in try/catch and never blocks a dispatch it cannot understand.

## How it works (API, verified from Kettu source)

- `src/core/vendetta/plugins.ts` — install = `<url>manifest.json` + `<url><main || "index.js">`; the file is evaluated as `vendetta => { return <file> }` and the plugin object is `{ onLoad, onUnload, settings? }`.
- `src/core/vendetta/api.tsx` — the `vendetta` object: `vendetta.metro.common.FluxDispatcher`, `vendetta.metro.common.React` / `ReactNative`, `vendetta.ui.toasts.showToast`, `vendetta.ui.semanticColors`, `vendetta.plugin.storage` (sync, ready in `onLoad`).
- `src/metro/common/types/flux.ts` + `src/lib/api/flux/index.ts` — `FluxDispatcher._interceptors`: an interceptor returning **true** blocks the dispatch. Kettu's own `injectFluxInterceptor` uses exactly this mechanism. The Bunny adapter uses `bunny.api.flux.intercept` instead, where the convention is inverted (**falsy** blocks) — see `src/bunny-adapter.js`.
- The reference plugin shape was copied from c10udburst's `hidden-channels` (`vendetta.metro`, `vendetta.metro.common`, `vendetta.patcher`, `vendetta.ui`), verified live at `https://c10udburst-discord.github.io/vendetta-plugins/hidden-channels/index.js`.

**A trap this repo avoids (and the sibling plugins fell into):** a Vendetta plugin file must start with the IIFE expression itself. A leading multi-line `/* ... */` comment contains a line terminator, so `return /* ... */ (function...)` makes JS insert a semicolon after `return` and the eval returns `undefined` — the plugin installs but silently never runs. Verified in Node against Kettu's exact eval string. This repo's `index.js` starts with `(function (vendetta) {` and the header comment lives inside the IIFE.

## Layout

```
index.js                         Vendetta format (generated — do not edit)
manifest.json                    Vendetta polymanifest (hash = sha256 of index.js)
repo.json                        Bunny plugin repository index
builds/messagelogger/
  index.js                       Bunny-native format (generated — do not edit)
  manifest.json                  Bunny manifest (spec 3)
src/
  core.js                        shared logic — the only file with behaviour
  vendetta-adapter.js            `vendetta` API adapter
  bunny-adapter.js               `bunny` API adapter
test/smoke.mjs                   mock-dispatcher behaviour tests (node test/smoke.mjs)
build.mjs                        generates both index.js files + manifests
index.html                       GitHub Pages landing page
```

Edit `src/`, then run `node build.mjs` (regenerates both plugin files and the manifest hash), `node --check index.js`, `node test/smoke.mjs`, then push — Kettu re-fetches on update.

## Licence

MIT. Written for the Kettu MAX project. Client mods violate Discord's ToS — test on a secondary account.
