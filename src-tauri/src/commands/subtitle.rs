// Subtitle window — a second, fully transparent always-on-top window that shows
// ONLY the current line, pinned near the bottom of the screen the way burned-in
// film subtitles sit.
//
// Click-through is the whole point. While LOCKED the window calls
// `set_ignore_cursor_events(true)`, so the mouse passes straight through to the
// video player underneath and scrubbing/pausing work as if nothing were there.
// Unlocking makes it solid again (and shows a frame) so the user can drag and
// resize it, then lock it back.
//
// Every window operation lives here in Rust rather than in JS: creating a
// transparent webview and toggling cursor pass-through from the frontend would
// need a fistful of extra capability grants on the main window, and the
// placement math wants the monitor geometry anyway.

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

pub const LABEL: &str = "subtitle";

/// Height of the subtitle strip, and how far above the screen bottom it sits.
/// Two lines of large text plus breathing room; the page itself is bottom-aligned
/// inside this box so a one-line cue hugs the same baseline as a two-line one.
const STRIP_HEIGHT: f64 = 200.0;
const BOTTOM_MARGIN: f64 = 48.0;
const WIDTH_RATIO: f64 = 0.86;

/// One cue pushed from the live session. `provisional` marks text the engine is
/// still revising, which the page renders dimmed.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SubtitleLine {
    #[serde(default)]
    pub src: String,
    #[serde(default)]
    pub tgt: String,
    #[serde(default)]
    pub provisional: bool,
}

/// Look of the cue. Mirrors the `subtitle_*` keys in Settings; pushed on open
/// and whenever the user changes them, so the page never reads settings itself.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct SubtitleStyle {
    pub font_size: u32,
    /// Show the source line above the translation.
    pub show_original: bool,
    /// Dim panel behind the text instead of an outline around it.
    pub boxed: bool,
    /// Clear the cue after this long with no new text. 0 = never clear.
    pub hold_ms: u32,
}

impl Default for SubtitleStyle {
    fn default() -> Self {
        Self {
            font_size: 30,
            show_original: true,
            boxed: false,
            hold_ms: 5000,
        }
    }
}

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

/// Bottom-centre of whichever monitor the main window is on (falls back to the
/// primary monitor). Logical units throughout so this behaves the same on a
/// HiDPI display.
fn place_bottom_centre(app: &AppHandle, win: &WebviewWindow) -> Result<(), String> {
    let monitor = app
        .get_webview_window("main")
        .and_then(|m| m.current_monitor().ok().flatten())
        .or_else(|| win.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or_else(|| "No monitor found".to_string())?;

    let scale = monitor.scale_factor();
    let size = monitor.size().to_logical::<f64>(scale);
    let pos = monitor.position().to_logical::<f64>(scale);

    let w = (size.width * WIDTH_RATIO).round();
    let h = STRIP_HEIGHT;
    let x = pos.x + ((size.width - w) / 2.0).round();
    let y = pos.y + size.height - h - BOTTOM_MARGIN;

    win.set_size(LogicalSize::new(w, h))
        .map_err(|e| format!("set_size failed: {}", e))?;
    win.set_position(LogicalPosition::new(x, y))
        .map_err(|e| format!("set_position failed: {}", e))?;
    Ok(())
}

/// Create the window if needed and show it. Built hidden, then positioned, then
/// shown — otherwise it flashes at the default centre position first.
///
/// `focused(false)` matters: stealing focus from a fullscreen video player is
/// exactly what a subtitle overlay must never do.
#[tauri::command]
pub async fn subtitle_open(app: AppHandle, style: Option<SubtitleStyle>) -> Result<(), String> {
    let existing = window(&app);
    let created = existing.is_none();
    let win = match existing {
        Some(w) => w,
        None => WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("subtitle.html".into()))
            .title("Subtitles")
            .inner_size(900.0, STRIP_HEIGHT)
            .transparent(true)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .resizable(true)
            .focused(false)
            .visible(false)
            .build()
            .map_err(|e| format!("Failed to create subtitle window: {}", e))?,
    };

    // Only place it on creation. Reopening must not undo a position the user
    // dragged to — the page restores that itself from its saved rect.
    if created {
        place_bottom_centre(&app, &win)?;
    }
    win.set_ignore_cursor_events(true)
        .map_err(|e| format!("set_ignore_cursor_events failed: {}", e))?;
    win.show().map_err(|e| format!("show failed: {}", e))?;

    // On a first open the page may not have registered its listener yet, so this
    // push can land in the void. Harmless: the page ships readable defaults and
    // the controller re-pushes the style shortly after opening.
    if let Some(s) = style {
        let _ = app.emit_to(LABEL, "subtitle-style", s);
    }
    Ok(())
}

#[tauri::command]
pub async fn subtitle_close(app: AppHandle) -> Result<(), String> {
    if let Some(win) = window(&app) {
        win.close().map_err(|e| format!("close failed: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub fn subtitle_is_open(app: AppHandle) -> bool {
    window(&app).is_some()
}

/// Locked = click-through (the normal state). Unlocked = solid, draggable,
/// and the page draws a frame so the invisible window can be grabbed.
#[tauri::command]
pub fn subtitle_set_locked(app: AppHandle, locked: bool) -> Result<(), String> {
    let win = window(&app).ok_or_else(|| "Subtitle window is not open".to_string())?;
    win.set_ignore_cursor_events(locked)
        .map_err(|e| format!("set_ignore_cursor_events failed: {}", e))?;
    let _ = app.emit_to(LABEL, "subtitle-locked", locked);
    Ok(())
}

#[tauri::command]
pub fn subtitle_push(app: AppHandle, line: SubtitleLine) -> Result<(), String> {
    if window(&app).is_none() {
        return Ok(()); // not open — pushing is a no-op, not an error
    }
    app.emit_to(LABEL, "subtitle-line", line)
        .map_err(|e| format!("emit failed: {}", e))
}

#[tauri::command]
pub fn subtitle_set_style(app: AppHandle, style: SubtitleStyle) -> Result<(), String> {
    if window(&app).is_none() {
        return Ok(());
    }
    app.emit_to(LABEL, "subtitle-style", style)
        .map_err(|e| format!("emit failed: {}", e))
}

/// Put the strip back at the bottom centre — the escape hatch for a window
/// dragged off-screen or onto a monitor that has since been unplugged.
#[tauri::command]
pub fn subtitle_reset_position(app: AppHandle) -> Result<(), String> {
    let win = window(&app).ok_or_else(|| "Subtitle window is not open".to_string())?;
    place_bottom_centre(&app, &win)
}
