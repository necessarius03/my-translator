/**
 * Subtitle overlay page — runs in the second, transparent window.
 *
 * It owns nothing: the main window decides what the cue says and how it looks,
 * and pushes both over Tauri events (`subtitle-line`, `subtitle-style`,
 * `subtitle-locked`). All this page does is paint, hold, and — while unlocked —
 * remember where the user dragged it.
 *
 * Geometry lives in localStorage rather than in Settings on purpose: both
 * windows are served from the same origin, so the main window can read the same
 * key, and a position is per-screen furniture, not a preference worth a
 * settings-file round trip.
 */

const RECT_KEY = 'subtitle_rect';

const cueEl = document.getElementById('cue');
const srcEl = document.getElementById('cue-src');
const tgtEl = document.getElementById('cue-tgt');

let holdMs = 5000;
let holdTimer = null;

/* ── Painting ─────────────────────────────────────────────── */

function renderLine({ src = '', tgt = '', provisional = false } = {}) {
    const text = (tgt || '').trim();
    const original = (src || '').trim();

    srcEl.textContent = original;
    tgtEl.textContent = text;

    cueEl.classList.toggle('empty', !text && !original);
    cueEl.classList.toggle('provisional', !!provisional);

    // Each new cue restarts the hold: subtitles should disappear during silence
    // the way burned-in ones do, instead of freezing the last sentence on screen.
    clearTimeout(holdTimer);
    if (holdMs > 0 && (text || original)) {
        holdTimer = setTimeout(() => cueEl.classList.add('empty'), holdMs);
    }
}

function applyStyle({ font_size, show_original, boxed, hold_ms } = {}) {
    if (typeof font_size === 'number' && font_size > 0) {
        document.body.style.setProperty('--cue-size', `${font_size}px`);
    }
    if (typeof show_original === 'boolean') {
        cueEl.classList.toggle('no-src', !show_original);
    }
    if (typeof boxed === 'boolean') {
        cueEl.classList.toggle('boxed', boxed);
        cueEl.classList.toggle('outlined', !boxed);
    }
    if (typeof hold_ms === 'number') {
        holdMs = hold_ms;
    }
}

/* ── Geometry ─────────────────────────────────────────────── */

function readRect() {
    try {
        const r = JSON.parse(localStorage.getItem(RECT_KEY) || 'null');
        if (r && Number.isFinite(r.x) && Number.isFinite(r.y) &&
            Number.isFinite(r.w) && Number.isFinite(r.h)) return r;
    } catch { /* corrupt entry — fall back to the Rust-side placement */ }
    return null;
}

function saveRect(rect) {
    try {
        localStorage.setItem(RECT_KEY, JSON.stringify(rect));
    } catch { /* best effort; a lost position just means bottom-centre next time */ }
}

async function restoreGeometry(appWindow, LogicalPosition, LogicalSize) {
    const r = readRect();
    if (!r) return; // Rust already placed us bottom-centre
    try {
        await appWindow.setSize(new LogicalSize(r.w, r.h));
        await appWindow.setPosition(new LogicalPosition(r.x, r.y));
    } catch (err) {
        console.warn('[subtitle] restore geometry failed:', err);
    }
}

async function watchGeometry(appWindow) {
    const persist = async () => {
        try {
            const factor = await appWindow.scaleFactor();
            const pos = await appWindow.outerPosition();
            const size = await appWindow.innerSize();
            saveRect({
                x: Math.round(pos.x / factor),
                y: Math.round(pos.y / factor),
                w: Math.round(size.width / factor),
                h: Math.round(size.height / factor),
            });
        } catch { /* ignore — geometry persistence is a convenience */ }
    };

    let timer = null;
    const debounced = () => {
        clearTimeout(timer);
        timer = setTimeout(persist, 400);
    };

    try {
        await appWindow.onMoved(debounced);
        await appWindow.onResized(debounced);
    } catch { /* older runtime without these hooks: position just won't persist */ }
}

/* ── Wiring ───────────────────────────────────────────────── */

async function init() {
    // Style defaults so the very first cue is readable even if the style event
    // has not arrived yet.
    cueEl.classList.add('outlined');

    const tauri = window.__TAURI__;
    if (!tauri) {
        console.warn('[subtitle] No Tauri runtime — page is inert.');
        return;
    }

    const { listen } = tauri.event;
    const { getCurrentWindow, LogicalPosition, LogicalSize } = tauri.window;
    const appWindow = getCurrentWindow();

    await listen('subtitle-line', (e) => renderLine(e.payload));
    await listen('subtitle-style', (e) => applyStyle(e.payload));
    await listen('subtitle-locked', (e) => {
        document.body.classList.toggle('unlocked', !e.payload);
    });

    await restoreGeometry(appWindow, LogicalPosition, LogicalSize);
    await watchGeometry(appWindow);
}

init();
