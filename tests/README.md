# Tests

Frontend behaviour suite. Not part of the app build.

## ui-suite.mjs

Drives the real UI in a headless browser against `src/js/tauri-mock.js`, the
dev-only mock that stands in for the Tauri runtime on port 3111.

Every check asserts that state actually **changed** — that switching to Qwen
really removes "Auto" from the source picker, that pausing the reader really
resumes where it left off. A suite that only checks "no console error" passes
happily while a button sits there doing nothing.

### Run

```bash
npm run test:ui
```

It serves `src/` in-process on :3111 (or reuses a `npm run dev:web` server
already there) and shuts down afterwards. Exit code is non-zero if any check
fails or the app produces a console / network error. Off-origin requests are
ignored -- `index.html` pulls Inter from Google Fonts, and the suite must still
pass with no internet.

Screenshots land in `tests/screenshots/` (gitignored) — useful when a check
fails and you want to see what the page actually looked like.

### Requirements

`playwright-core` plus Chrome or Edge already installed on the machine. The
suite launches the system browser via `channel`, so there is **no** playwright
browser download, and it serves the files itself, so there is no `serve`
dependency either.

### What it covers

Everything that needs no API key:

- engine switching and the Settings sections it drives (key fields, language
  lists, Soniox-only blocks, two-way availability)
- Settings wizard cards
- all seven TTS provider panels, plus the Microsoft and Local voice managers
  including a model download
- Read mode: chunking, highlight, progress, pause/resume, stop, end-of-text
- session library
- keyboard shortcuts, font size, dual-panel
- one cross-controller rule: two-way mode locks the TTS button

### What it does NOT cover

The mock is not Tauri. These need the real app and a provider key:

- live translation sessions (start / pause / stop against a real engine)
- engine reconnect and backoff
- real audio output — the mock returns a silent clip, so the suite proves the
  reader advances, not that anything is audible
- real session files on disk
- window geometry, pin, compact, the exit flush
- the MLX setup modal (macOS Apple Silicon only)
- the updater
