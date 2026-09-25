/**
 * Window + overlay chrome: activity shell, overflow menu, shortcut sheet,
 * pin / compact / dual-panel / font size, and window geometry.
 */
import { initShell, bindMenu, toggleManualCompact, isAutoHideEnabled, setAutoHideEnabled } from '../ui-shell.js';
import { showToast } from '../util/toast.js';

export class WindowChromeController {
    constructor(app) {
        this.app = app;
        // Always-on-top state.
        this.isPinned = true;
        // Compact mode (hide control bar).
        this.isCompact = false;
        this.moreMenu = null;
        this.toggleShortcutSheet = () => {};
    }

    /** Activity switcher, overflow menu, shortcut sheet and auto-hide toggle. */
    initShell() {
        // Activity shell: switcher clicks → panels; side effects handled here.
        initShell();
        // Overflow menu (⋯) in the Live action row
        this.moreMenu = bindMenu('btn-more', 'more-menu');
        // Menu items that navigate/close: shut the menu after action
        ['btn-copy', 'btn-clear', 'btn-compact', 'btn-shortcuts'].forEach((id) => {
            document.getElementById(id)?.addEventListener('click', () => this.moreMenu.close());
        });
        // Shortcut sheet (⋯ menu + `?` key; Esc/click-outside closes)
        const sheet = document.getElementById('shortcut-sheet');
        const toggleSheet = (show) => { if (sheet) sheet.style.display = show ? '' : 'none'; };
        document.getElementById('btn-shortcuts')?.addEventListener('click', () => toggleSheet(true));
        sheet?.addEventListener('click', (e) => { if (e.target === sheet) toggleSheet(false); });
        this.toggleShortcutSheet = toggleSheet;

        // Auto-hide toolbar toggle (✓ prefix reflects state; persists in localStorage)
        const autoHideBtn = document.getElementById('btn-auto-hide');
        const renderAutoHide = () => {
            if (autoHideBtn) {
                autoHideBtn.textContent = `${isAutoHideEnabled() ? '✓' : '  '} Auto-hide while translating`;
            }
        };
        renderAutoHide();
        autoHideBtn?.addEventListener('click', () => {
            setAutoHideEnabled(!isAutoHideEnabled());
            renderAutoHide();
        });
    }

    bindEvents() {
        // Close button (overlay) — flows through the onCloseRequested hook,
        // which flushes the session before the app exits.
        document.getElementById('btn-close').addEventListener('click', async () => {
            await this.savePosition();
            await this.app.appWindow.close();
        });

        // (Minimize button removed from toolbar — ⌘M / window menu still work)

        // Pin/Unpin button
        document.getElementById('btn-pin').addEventListener('click', () => {
            this.togglePin();
        });

        // Compact mode button
        document.getElementById('btn-compact').addEventListener('click', () => {
            this.toggleCompact();
        });

        // View mode toggle (dual panel)
        document.getElementById('btn-view-mode').addEventListener('click', () => {
            this.toggleViewMode();
        });

        // Font size quick controls
        document.getElementById('btn-font-up').addEventListener('click', () => this.adjustFontSize(4));
        document.getElementById('btn-font-down').addEventListener('click', () => this.adjustFontSize(-4));

        // Color dot controls
        document.querySelectorAll('.color-dot').forEach(dot => {
            dot.addEventListener('click', () => {
                document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
                dot.classList.add('active');
                const color = dot.dataset.color;
                this.app.transcriptUI.configure({ fontColor: color });
            });
        });
    }

    async savePosition() {
        try {
            const factor = await this.app.appWindow.scaleFactor();
            const pos = await this.app.appWindow.outerPosition();
            const size = await this.app.appWindow.innerSize();
            // Save logical coordinates (physical / scaleFactor)
            localStorage.setItem('window_state', JSON.stringify({
                x: Math.round(pos.x / factor),
                y: Math.round(pos.y / factor),
                width: Math.round(size.width / factor),
                height: Math.round(size.height / factor),
            }));
        } catch (err) {
            console.error('Failed to save window position:', err);
        }
    }

    // Currently unused: restoring geometry misbehaves on Retina displays.
    // Kept because the fix belongs here if window state is reinstated.
    async restorePosition() {
        try {
            const saved = localStorage.getItem('window_state');
            if (!saved) return;

            const state = JSON.parse(saved);
            const { LogicalPosition, LogicalSize } = window.__TAURI__.window;

            // Validate — don't restore if position seems off-screen
            if (state.x < -100 || state.y < -100 || state.x > 5000 || state.y > 3000) {
                console.warn('Saved window position looks off-screen, skipping restore');
                localStorage.removeItem('window_state');
                return;
            }

            if (state.width && state.height && state.width >= 300 && state.height >= 100) {
                await this.app.appWindow.setSize(new LogicalSize(state.width, state.height));
            }
            if (state.x !== undefined && state.y !== undefined) {
                await this.app.appWindow.setPosition(new LogicalPosition(state.x, state.y));
            }
        } catch (err) {
            console.error('Failed to restore window position:', err);
            localStorage.removeItem('window_state');
        }
    }

    async togglePin() {
        this.isPinned = !this.isPinned;
        await this.app.appWindow.setAlwaysOnTop(this.isPinned);
        const btn = document.getElementById('btn-pin');
        if (btn) btn.classList.toggle('active', this.isPinned);
        showToast(this.isPinned ? 'Pinned on top' : 'Unpinned — window can go behind other apps', 'success');
    }

    toggleCompact() {
        // Unified with auto-hide in ui-shell — one chrome hide/show mechanism.
        this.isCompact = toggleManualCompact();
    }

    toggleViewMode() {
        const isDual = this.app.transcriptUI.viewMode === 'dual';
        const newMode = isDual ? 'single' : 'dual';
        this.app.transcriptUI.configure({ viewMode: newMode });
        const btn = document.getElementById('btn-view-mode');
        if (btn) btn.classList.toggle('active', newMode === 'dual');
    }

    adjustFontSize(delta) {
        const current = this.app.transcriptUI.fontSize || 16;
        const newSize = Math.max(12, Math.min(140, current + delta));
        this.app.transcriptUI.configure({ fontSize: newSize });

        // Update display
        const display = document.getElementById('font-size-display');
        if (display) display.textContent = newSize;

        // Sync with settings slider
        const slider = document.getElementById('range-font-size');
        if (slider) slider.value = newSize;
        const sliderVal = document.getElementById('font-size-value');
        if (sliderVal) sliderVal.textContent = `${newSize}px`;
    }
}
