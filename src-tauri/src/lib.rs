mod audio;
mod commands;
mod settings;

use audio::microphone::MicCapture;
use audio::SystemAudioCapture;
use commands::audio::AudioState;
use commands::local_pipeline::LocalPipelineState;
use commands::local_tts::LocalTtsState;
use commands::openai_realtime::OpenAiState;
use commands::qwen_realtime::QwenState;
use settings::{Settings, SettingsState};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

// Set once the frontend has flushed the session (or the exit deadline elapsed),
// so the ExitRequested handler stops preventing exit and the app can quit.
static EXIT_ALLOWED: AtomicBool = AtomicBool::new(false);

// True only once the OS has actually granted the window a native backdrop
// (Mica on Windows 11, NSVisualEffect on macOS). The frontend reads this and
// only then thins its own ground — see `--bg-primary` in tokens.css.
//
// It must stay false on failure. The window is `transparent: true` so the
// material can show through at all, which means a thinned ground with no
// material behind it would leave text sitting on raw desktop wallpaper. That
// is the exact trade the light theme's comment rejects, so the fallback has
// to be the opaque ground, and the default has to be the safe one.
static NATIVE_MATERIAL: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn get_platform_info() -> String {
    // `std::env::consts::ARCH` is the arch of THIS binary, not the CPU. On an
    // Apple Silicon Mac running the x64 build under Rosetta it reports
    // "x86_64", which wrongly blocked the Local MLX engine (MLX runs as a
    // separate native-ARM Python subprocess, so it works fine there).
    // Ask the hardware directly so detection is Rosetta-proof.
    let is_arm_hardware = is_apple_silicon_hardware();
    format!(
        r#"{{"os":"{}","arch":"{}","is_arm_hardware":{},"native_material":{},"version":"0.3.0"}}"#,
        std::env::consts::OS,
        std::env::consts::ARCH,
        is_arm_hardware,
        NATIVE_MATERIAL.load(Ordering::Relaxed)
    )
}

/// True only on Apple Silicon hardware (macOS), even when the current process
/// is x86_64 under Rosetta. Uses `sysctl hw.optional.arm64`, which reads the
/// real CPU, not the process translation state. Non-macOS → false.
#[cfg(target_os = "macos")]
fn is_apple_silicon_hardware() -> bool {
    std::process::Command::new("sysctl")
        .args(["-n", "hw.optional.arm64"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim() == "1")
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn is_apple_silicon_hardware() -> bool {
    false
}

/// Ask the OS for a native window backdrop. Returns whether it was granted.
///
/// This is composited by the OS, not by the WebView, so it costs nothing per
/// frame — which is the point. The CSS `backdrop-filter` glass has to repaint
/// everything behind it every frame and is capped at three surfaces for that
/// reason (see tokens.css); a native material is free.
///
/// Deliberately NOT falling back to Acrylic on Windows 10: window-vibrancy's
/// acrylic makes resizing visibly lag on Win10, and this window is resizable.
/// An honest `false` and the opaque ground is the better outcome there.
#[allow(unused_variables)]
fn apply_native_material(win: &tauri::WebviewWindow) -> bool {
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{NSVisualEffectMaterial, NSVisualEffectState};
        // Sidebar is a heavily tinted material, not a clear one: the desktop
        // reads as a faint cast behind the glass rather than as a picture, which
        // keeps a continuously-read transcript legible.
        // FollowsWindowActiveState is what makes it dim when the app loses
        // focus, the way every native macOS panel does.
        return window_vibrancy::apply_vibrancy(
            win,
            NSVisualEffectMaterial::Sidebar,
            Some(NSVisualEffectState::FollowsWindowActiveState),
            None,
        )
        .inspect_err(|e| eprintln!("[window] native vibrancy unavailable: {e}"))
        .is_ok();
    }

    #[cfg(target_os = "windows")]
    {
        // `None` lets Mica follow the system light/dark setting, which is the
        // same signal the stylesheet's prefers-color-scheme block follows, so
        // the two cannot disagree. Windows 11 (build 22000+) only; older builds
        // return UnsupportedPlatformVersion and we keep the opaque ground.
        return window_vibrancy::apply_mica(win, None)
            .inspect_err(|e| eprintln!("[window] native mica unavailable: {e}"))
            .is_ok();
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    false
}

// Called by the frontend after it has flushed the session on exit. Force-exits
// the process; the flag keeps a subsequent ExitRequested from being prevented.
#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    EXIT_ALLOWED.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load settings from disk (or defaults)
    let initial_settings = Settings::load();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }
            {
                use tauri::Manager;
                if let Some(win) = app.get_webview_window("main") {
                    if apply_native_material(&win) {
                        NATIVE_MATERIAL.store(true, Ordering::Relaxed);
                    }
                }
            }
            // Dev builds (compiled with the `devtools` feature): auto-open the WebView
            // inspector so JS/console errors are visible. Never compiled into release.
            #[cfg(feature = "devtools")]
            {
                use tauri::Manager;
                if let Some(win) = app.get_webview_window("main") {
                    win.open_devtools();
                }
            }
            Ok(())
        })
        .manage(SettingsState(Mutex::new(initial_settings)))
        .manage(AudioState {
            system_audio: Mutex::new(SystemAudioCapture::new()),
            microphone: Mutex::new(MicCapture::new()),
            active_receiver: Mutex::new(None),
        })
        .manage(LocalPipelineState {
            process: Mutex::new(None),
        })
        .manage(LocalTtsState::default())
        .manage(OpenAiState::default())
        .manage(QwenState::default())
        .invoke_handler(tauri::generate_handler![
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::audio::start_capture,
            commands::audio::stop_capture,
            commands::transcript::open_transcript_dir,
            commands::subtitle::subtitle_open,
            commands::subtitle::subtitle_close,
            commands::subtitle::subtitle_is_open,
            commands::subtitle::subtitle_set_locked,
            commands::subtitle::subtitle_push,
            commands::subtitle::subtitle_set_style,
            commands::subtitle::subtitle_reset_position,
            commands::summarize::summarize_text,
            commands::session_store::save_session,
            commands::session_store::list_sessions,
            commands::session_store::read_session,
            commands::session_store::read_legacy_session,
            commands::session_store::delete_session,
            commands::session_store::update_session_title,
            commands::session_store::export_session_srt,
            commands::session_store::export_session_txt,
            commands::session_store::search_sessions,
            commands::local_pipeline::start_local_pipeline,
            commands::local_pipeline::send_audio_to_pipeline,
            commands::local_pipeline::stop_local_pipeline,
            commands::local_pipeline::check_mlx_setup,
            commands::local_pipeline::run_mlx_setup,
            commands::edge_tts::edge_tts_speak,
            commands::microsoft_tts::microsoft_list_voices,
            commands::google_free_tts::google_free_tts_speak,
            commands::tiktok_tts::tiktok_tts_speak,
            commands::local_tts::local_tts_speak,
            commands::local_tts::local_tts_list_models,
            commands::local_tts::local_tts_models_dir_path,
            commands::local_tts::local_tts_download_model,
            commands::local_tts::local_tts_delete_model,
            commands::openai_realtime::openai_realtime_start,
            commands::openai_realtime::openai_realtime_send_audio,
            commands::openai_realtime::openai_realtime_stop,
            commands::qwen_realtime::qwen_realtime_start,
            commands::qwen_realtime::qwen_realtime_send_audio,
            commands::qwen_realtime::qwen_realtime_stop,
            get_platform_info,
            exit_app,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Cmd+Q and Dock → Quit fire app-level ExitRequested (not the
            // window's onCloseRequested). Prevent the first exit, ask the
            // frontend to flush the session, and force-exit after a deadline so
            // a hung flush can never make the app unquittable.
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if !EXIT_ALLOWED.load(Ordering::SeqCst) {
                    use tauri::{Emitter, Manager};
                    api.prevent_exit();
                    if let Some(win) = app_handle.get_webview_window("main") {
                        let _ = win.emit("app-exit-requested", ());
                    }
                    let handle = app_handle.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(3));
                        EXIT_ALLOWED.store(true, Ordering::SeqCst);
                        handle.exit(0);
                    });
                }
            }
        });
}
