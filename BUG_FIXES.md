# Music player fixes and improvements

## Playback and state

| Bug / root cause | Fix |
| --- | --- |
| Rapid skips could race React effects, stale queue refs, and asynchronous song/URL resolution. | A synchronous `PlaybackController` owns queue identity and playback intent. Generation checks and abort signals discard superseded work. App-level song selection also rejects stale resolutions. |
| Pause during loading could be overwritten by the original autoplay request. | Playback intent is checked after asynchronous preparation and native `play()`. Pausing also cancels a pending incoming crossfade deck. |
| Delayed native play events could restart a paused track. | Source/play request generations and an explicit native play-intent gate reject late completions. |
| Clearing the queue or replacing a loading track left media load promises, listeners, and timeouts alive. | Cancelling a source immediately rejects its pending load and releases listeners, timeout, and native source. Worker/token waits remove cancellation listeners. |
| Empty queues, duplicate entries, and queue edits could invalidate the selected index. | Queue changes preserve the selected song's stable identity. Empty queues stop cleanly; invalid indices and malformed persisted values are bounded or rejected. |
| Shuffle restoration could resurrect removed songs or lose newly queued songs. | Original order is reconciled with the current queue, retaining edits and the active track. |
| End-of-queue, repeat, and failed-track transitions could leave play state stale or retry indefinitely. | Explicit end handling, repeat-one/all behavior, and a bounded failed-track set stop exhaustion cleanly. Authentication and autoplay failures require a recoverable retry. |
| Autoplay denial discarded usable loaded audio. | Keep the loaded source and expose an explicit Play retry. |
| Next-track loading started too late and could duplicate preparation after queue changes. | Preload one native standby decoder, reuse it at transition, and invalidate it when the next source changes. |
| A shared Web Audio graph could detach one deck when another was attached. | Each native engine owns its graph, with independent volume and crossfade gain stages. |
| Seek requests before metadata were lost; dragging issued many network seeks. | The engine retains pre-metadata seeks. The progress control previews dragging and commits once on release; cancellation discards the preview. |
| Animation-frame-driven motor operations could remain unfinished when backgrounded. | Visibility changes settle motor operations, release scratch/needle state, and preserve native playback. Foregrounding resumes a suspended audio context when needed. |
| Reverse scratching at the beginning could incorrectly advance the queue. | Hold at the beginning without emitting an ordinary track-ended event. |
| Native volume zero did not reliably mute on mobile platforms. | Set the native `muted` property as well as the output level. |
| Disposed media elements/graphs could be reused during React StrictMode remounts. | Activation creates fresh native engines after disposal; disposal closes contexts and releases both decks. |
| Disconnecting during overlap could leave the outgoing deck audible and lose position. | Cancel preparation, finish overlap, stop both decks, and retain the selected position for a paused reconnect. |
| Persisted queue metadata could retain transient audio/cache payloads. | Strip transient fields from both live and original queue orders; persist bounded settings and position. |

## Streaming

| Bug / root cause | Fix |
| --- | --- |
| The service worker truncated open-ended and no-range streams into artificial chunks. | Forward the native requested range, or the full streamed response for an ordinary request. Audio remains streamed rather than decoded into a whole-file JavaScript buffer. |
| Suffix, invalid, and out-of-bounds byte ranges produced incorrect responses. | Parse full/open/suffix ranges correctly; return `416` and the total-size content range for unsatisfiable requests. |
| Cancelled stream requests could continue retries or retain response bodies. | Propagate the request signal through metadata and media fetches, stop abort retries, and cancel discarded response bodies. |
| A late `401` from an old token could clear a newer token. | Compare the captured token version before invalidating authentication or caching metadata. |
| Stream interception was too broad and malformed identifiers could throw. | Restrict interception to the app's origin/scope and handle malformed identifiers safely. |

## Interface, animation, and cleanup

| Bug / root cause | Fix |
| --- | --- |
| Vinyl rotation continued after Pause, and reduced-motion preferences did not cover all JavaScript animation. | Freeze the record at its current angle, stop unnecessary frames, and respond to reduced-motion changes. |
| Releasing the tonearm could toggle playback and pause a playing track. | Tonearm release seeks and restores needle state without toggling transport intent. |
| Gesture distance used the platter centre rather than pointer origin; cancellation could trigger actions. | Measure displacement from pointer-down and give cancellation/lost capture dedicated cleanup paths. |
| Long-press/swipe actions could fire during scrolling or be followed by an accidental play click. | Cancel on scroll movement and suppress the following primary action after a completed gesture. |
| Progress appeared stepped and volume changes could click through Web Audio. | Render progress from native time in an isolated visual frame loop; smooth gain changes over 15 ms. |
| Track transitions remounted the whole expanded player and could flash old artwork. | Preserve the expanded container/focus, reset only the track-specific turntable, and key artwork results to the requested source. Failed artwork uses a fallback. |
| Queue reordering lacked direct manipulation and its visible slice hid later tracks. | Add pointer/touch handles, keyboard move controls, stable row identity, reorder animation, filtering, and pagination. |
| Queue rows squeezed titles to almost zero width. | Allocate dedicated columns to handles, song text, and actions; widen the desktop panel while retaining responsive bounds. |
| Expanded-player grid sizing let the platter overlap song details; mobile navigation covered the player. | Prevent grid-row shrinkage, bound the platter at smaller sizes, place transport before metadata, and hide the mobile navigation while expanded. |
| New playback settings created an implicit desktop grid row and crowded mobile transport. | Use an anchored desktop control and explicit mobile columns with a reachable settings panel. |
| Several transitions used broad `transition: all` behavior and paused activity bars kept animating. | Apply shared short transition timing to player controls, freeze paused bars, and disable nonessential motion under reduced motion. |
| The constellation rotated faster on high-refresh displays and continued unnecessary animation while hidden. | Use elapsed-time rotation, suspend hidden/reduced-motion frames, redraw on direct manipulation, and release shader handles and fallback timers. |
| Escape affected multiple nested dialogs and focus could return to detached elements. | Only the top dialog handles focus trapping/Escape; restore focus only to connected elements. |
| Toast timers and audio-import metadata elements outlived their owners. | Clear toast timers on unmount and release metadata listeners, source, element playback, and object URLs on every completion path. |
| A failed Google Identity script could make retry impossible; StrictMode cancelled the only initial sync. | Reset failed script loading and mark initial sync complete only when its scheduled callback actually runs. |

## Library and persistence

| Bug / root cause | Fix |
| --- | --- |
| Empty playlists were filtered out or deleted after removing the last song. | Keep empty playlists and support explicit creation from the desktop sidebar and mobile More menu, including when no playlists exist. |
| Concurrent play-count read/modify/write operations lost increments. | Increment inside an atomic IndexedDB modification. |
| Concurrent outbox edits created duplicate queued rows or overwrote fields. | Transactionally coalesce queued edits, merge metadata patches, and preserve a separate later edit while an earlier operation is processing. |
| Reactive rerenders or multiple tabs could send the same outbox operation concurrently. | Atomically claim operations with per-entity exclusion, expiring leases, and claim IDs. Recover expired claims and ignore stale completions. |
| Single-character searches were unnecessarily ignored. | Filter the library for any nonempty query. |

## Features available after this pass

- Shuffle, smart shuffle, repeat one/all, add to queue, and play next, with corrected queue semantics.
- Drag/touch queue reordering, keyboard move buttons, queue search, remove-current, clear, and access to the complete queue.
- Persistent mini-player with mute, repeat, loading state, smooth seek/buffer display, and playback settings.
- Native next-track preloading and optional 0–12 second crossfade, cancelled correctly by pause, seek, skip, stop, and disconnect.
- Sleep timer for 5/15/30/45/60/90 minutes or the end of the current track. End-of-track sleep takes precedence over crossfade; timed sleep uses a persisted wall-clock deadline.
- Media Session play/pause/stop, previous/next, seek, metadata, and position reporting; unsupported actions are isolated.
- Keyboard play/pause, seek, and mute without hijacking text entry or dialog controls.
- Library search and playlist creation/membership, including empty playlists and mobile creation.

Several standard features already existed. This pass retained their UI style, repaired their behavior, and added the missing controls and capabilities above.

## Verification and limits

`npm run lint`, `npm test` (83 tests), and `npm run build` pass. The browser suite exercises the real React app in StrictMode with native local WAV audio: preloading, rapid skips, pause/mute, seek release/cancellation, tonearm behavior, reduced motion, nested dialogs, simultaneous crossfade playback, Media Session handlers, queue edits, playlist creation, sleep, and IndexedDB concurrency. Desktop (1440×1000), tablet (834×1112), and mobile (390×844) screenshots were inspected; the suite checks control bounds and player overlap. No browser console errors were recorded.

Authenticated Google Drive streaming and physical iPhone/Android lock-screen behavior still need device verification. Native decoding and preloading reduce transition delays; network stalls and operating-system suspension can still interrupt audio. EQ/crossfade use Web Audio, whose background policy varies by browser. A suspended browser cannot guarantee a timed sleep callback at the exact deadline; expiry is also checked on playback events and return to the foreground.

### Running the browser checks

The development fixture is isolated from real accounts, generates local audio, and is excluded from the production entry. Start the server with dummy configuration:

```sh
VITE_GOOGLE_CLIENT_ID=local-fixture VITE_SPOTIFY_JSON_FILE_ID=local-fixture VITE_DRIVE_FOLDER_ID=local-fixture npm run dev -- --host 127.0.0.1 --port 5178 --strictPort
```

With Playwright and Chromium available, run `npm run test:browser`. If using an external Playwright installation or system Chrome, set `PLAYWRIGHT_PACKAGE` to its module path and `CHROME_PATH` to the Chrome executable. `PLAYER_TEST_URL` overrides the server URL and `PLAYER_TEST_OUTPUT` overrides the screenshot directory (default `/tmp/sisic-player-checks`).
