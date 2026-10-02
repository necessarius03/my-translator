/**
 * UI Shell — activity-first navigation for the main overlay window.
 *
 * Owns WHICH activity panel (live | read | library) is visible and the
 * top-bar switcher state. Side effects of entering/leaving an activity
 * (pausing the live session, draining TTS, rendering the session list)
 * stay in app.js, which listens for the `activity-changed` CustomEvent
 * dispatched from here.
 */

const ACTIVITIES = ['live', 'meeting', 'read', 'library'];

let currentActivity = 'live';

export function getActivity() {
    return currentActivity;
}

export function setActivity(id) {
    if (!ACTIVITIES.includes(id) || id === currentActivity) return;
    const previous = currentActivity;
    currentActivity = id;

    document.querySelectorAll('.activity-tab').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.activity === id);
    });
    document.querySelectorAll('.activity-panel').forEach((p) => {
        p.classList.toggle('active', p.dataset.activity === id);
    });
    // Body class lets CSS adapt shared chrome (e.g. hide floating controls
    // outside Live) without JS touching each element.
    ACTIVITIES.forEach((a) => document.body.classList.toggle(`activity-${a}`, a === id));

    document.dispatchEvent(new CustomEvent('activity-changed', {
        detail: { activity: id, previous },
    }));
}

/**
 * Red "recording" dot on the tab that owns the running session, so the badge
 * points at where the session actually is when the user is on another tab.
 * The badge is a single node that moves rather than one node per tab.
 */
export function setLiveBadge(on, activity = 'live') {
    const badge = document.getElementById('live-tab-badge');
    if (!badge) return;
    if (on) {
        const tab = document.querySelector(`.activity-tab[data-activity="${activity}"]`);
        if (tab && badge.parentElement !== tab) tab.appendChild(badge);
    }
    badge.classList.toggle('visible', !!on);
}

export function initShell() {
    document.querySelectorAll('.activity-tab').forEach((btn) => {
        btn.addEventListener('click', () => setActivity(btn.dataset.activity));
    });
    document.body.classList.add('activity-live');

    // Auto-hide interaction watchers (armed only while a live session runs)
    window.addEventListener('mousemove', onChromeInteract, { passive: true });
    window.addEventListener('keydown', onChromeInteract);
}

/* ── Chrome hide/show — ONE mechanism for manual Compact and auto-hide ──
 * Reuses the existing compact CSS (drag-region.compact-hidden +
 * overlay.compact-mode with its hover-reveal). Manual compact wins over
 * the auto watcher: interactions never un-hide a manually compacted UI. */

const AUTO_HIDE_IDLE_MS = 3000;

let manualCompact = false;
let chromeHidden = false;
let autoWatching = false;
let autoHideEnabled = localStorage.getItem('auto_hide_toolbar') !== '0'; // default ON
let idleTimer = null;
let lastInteract = 0;

function setChromeHidden(hide) {
    chromeHidden = hide;
    document.getElementById('drag-region')?.classList.toggle('compact-hidden', hide);
    document.getElementById('overlay-view')?.classList.toggle('compact-mode', hide);
    document.querySelector('.live-status-row')?.classList.toggle('chrome-hidden', hide);
    document.querySelector('.live-action-row')?.classList.toggle('chrome-hidden', hide);
}

function armIdleTimer() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        if (autoWatching && autoHideEnabled && !manualCompact &&
            currentActivity === 'live' && !anyMenuOpen()) {
            setChromeHidden(true);
        }
    }, AUTO_HIDE_IDLE_MS);
}

function onChromeInteract() {
    const now = Date.now();
    if (now - lastInteract < 100) return; // throttle for transcript-stream perf
    lastInteract = now;
    if (!autoWatching) return;
    if (chromeHidden && !manualCompact) setChromeHidden(false);
    armIdleTimer();
}

/** Called by app when a live session starts/stops. */
export function startAutoHideWatch() {
    if (autoWatching) return;
    autoWatching = true;
    armIdleTimer();
}

export function stopAutoHideWatch() {
    autoWatching = false;
    clearTimeout(idleTimer);
    if (!manualCompact && chromeHidden) setChromeHidden(false);
}

/** Manual Compact from the ⋯ menu — sticky until toggled back. */
export function toggleManualCompact() {
    manualCompact = !manualCompact;
    setChromeHidden(manualCompact);
    return manualCompact;
}

export function isAutoHideEnabled() {
    return autoHideEnabled;
}

export function setAutoHideEnabled(on) {
    autoHideEnabled = !!on;
    localStorage.setItem('auto_hide_toolbar', on ? '1' : '0');
    if (!on && !manualCompact && chromeHidden) setChromeHidden(false);
}

/**
 * Wire a trigger button to a dropdown/menu element: click toggles, click
 * outside or Esc closes. Returns { close } so callers can close programmatically.
 */
export function bindMenu(triggerId, menuId) {
    const trigger = document.getElementById(triggerId);
    const menu = document.getElementById(menuId);
    if (!trigger || !menu) return { close: () => {} };

    const close = () => { menu.style.display = 'none'; };
    const isOpen = () => menu.style.display !== 'none';

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.style.display = isOpen() ? 'none' : '';
    });
    document.addEventListener('click', (e) => {
        if (isOpen() && !menu.contains(e.target)) close();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isOpen()) close();
    });
    return { close };
}

/** True while any shell-managed menu/popover is open (used by auto-hide). */
export function anyMenuOpen() {
    const m = document.getElementById('more-menu');
    return !!m && m.style.display !== 'none';
}

/* ── Window modes: overlay (small, floating) ↔ expanded (comfortable) ──
 * Sizes persist per-mode in localStorage (same store the app already uses
 * for window_state), so no backend settings round-trip is needed. */

const EXPANDED_DEFAULT = { w: 900, h: 640 };

/* Overlay is the glance surface, so its default is genuinely small. Measured
 * against the layout rather than guessed: the status row needs ~428px for the
 * engine pill, the language pair and the source picker, and the fixed chrome
 * (title bar 46 + status 42 + action row 61) is 149px tall, leaving room for
 * about five transcript lines. Both are comfortably above the window's
 * minWidth/minHeight of 380x220. */
const OVERLAY_DEFAULT = { w: 480, h: 320 };

/* Sizes are versioned. v1 wrote the size of the mode you were LEAVING on every
 * toggle, so the first expand silently recorded the 900x500 startup size as if
 * it were a chosen overlay size — after which shrinking restored 900x500
 * forever and never looked small. Bumping the key abandons those values once;
 * a size is now only stored when the user actually resizes. */
const SIZE_KEY = (mode) => `win_size_v2_${mode}`;

let appWindowRef = null;
let windowMode = 'overlay';
let applyingMode = false; // guard: programmatic setSize must not overwrite saved sizes
let resizeSaveTimer = null;

export function getWindowMode() {
    return windowMode;
}

async function currentLogicalSize() {
    const factor = await appWindowRef.scaleFactor();
    const size = await appWindowRef.innerSize();
    return { w: Math.round(size.width / factor), h: Math.round(size.height / factor) };
}

async function saveSizeForMode(mode) {
    try {
        localStorage.setItem(SIZE_KEY(mode), JSON.stringify(await currentLogicalSize()));
    } catch { /* size save is best-effort */ }
}

export async function applyWindowMode(mode) {
    if (!appWindowRef || (mode !== 'overlay' && mode !== 'expanded')) return;
    const { LogicalSize } = window.__TAURI__.window;

    // Deliberately NOT saving the size of the mode being left: that is what
    // recorded a size the user never chose. onResized below stores a size when
    // the user actually drags the window, which is the only signal that means
    // anything.
    windowMode = mode;
    localStorage.setItem('window_mode', mode);
    document.body.classList.toggle('expanded', mode === 'expanded');

    let target = null;
    try { target = JSON.parse(localStorage.getItem(SIZE_KEY(mode)) || 'null'); } catch { }
    // Every mode has a default. Without one for overlay, shrinking changed the
    // CSS class and never called setSize at all, so the window stayed at the
    // expanded size while the layout went compact.
    if (!target) target = mode === 'expanded' ? EXPANDED_DEFAULT : OVERLAY_DEFAULT;
    if (target) {
        applyingMode = true;
        try { await appWindowRef.setSize(new LogicalSize(target.w, target.h)); } catch { }
        applyingMode = false;
    }
    const btn = document.getElementById('btn-window-mode');
    if (btn) btn.title = mode === 'expanded' ? 'Shrink back to the small overlay' : 'Expand window';
}

export async function toggleWindowMode() {
    await applyWindowMode(windowMode === 'expanded' ? 'overlay' : 'expanded');
}

export async function initWindowModes(appWindow) {
    appWindowRef = appWindow;
    document.getElementById('btn-window-mode')?.addEventListener('click', () => toggleWindowMode());

    // User resizes update the remembered size of the CURRENT mode (debounced).
    try {
        await appWindow.onResized(() => {
            if (applyingMode) return;
            clearTimeout(resizeSaveTimer);
            // Capture the mode NOW, not when the timer fires: toggling within
            // the debounce window would otherwise file this size under the mode
            // the user just switched to.
            const modeAtResize = windowMode;
            resizeSaveTimer = setTimeout(() => saveSizeForMode(modeAtResize), 500);
        });
    } catch { /* onResized unavailable — sizes just won't persist */ }

    // Apply whichever mode was last used, including overlay. Previously only
    // 'expanded' was restored, so a user who left the app shrunk reopened it at
    // the 900x500 startup size with the compact layout — the same mismatch
    // shrinking itself used to produce.
    const saved = localStorage.getItem('window_mode');
    await applyWindowMode(saved === 'expanded' ? 'expanded' : 'overlay');
}
