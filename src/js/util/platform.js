/**
 * Platform detection + the UI consequences of it: Local MLX labelling, and
 * whether the OS granted this window a native backdrop.
 * Returns { os, isAppleSilicon, nativeMaterial }; kept on `app.platform`.
 */
import { settingsManager } from '../settings.js';

const { invoke } = window.__TAURI__.core;

export async function detectPlatform() {
    const platform = { os: 'macos', isAppleSilicon: false, nativeMaterial: false };
    try {
        // Apple Silicon detection must be Rosetta-proof: the x64 build on an
        // ARM Mac reports arch "x86_64" but is_arm_hardware asks the real CPU.
        // MLX runs as a native-ARM Python subprocess, so it works even when
        // the app binary itself is x64-under-Rosetta.
        const arch = await invoke('get_platform_info');
        const info = JSON.parse(arch);
        platform.os = info.os; // 'macos' | 'windows' | 'linux'
        platform.isAppleSilicon = info.is_arm_hardware === true
            || (info.os === 'macos' && info.arch === 'aarch64');

        // Only Rust knows whether the material actually applied — Tauri's own
        // set_effects swallows that error, so lib.rs calls window-vibrancy
        // directly for the real Result. The attribute lets the stylesheet thin
        // its ground; its ABSENCE is the safe state, so nothing is ever removed
        // here on failure.
        platform.nativeMaterial = info.native_material === true;
        if (platform.nativeMaterial) {
            document.documentElement.dataset.nativeMaterial = '';
        }
    } catch {
        // Fallback: check via navigator
        platform.os = navigator.userAgent.includes('Mac OS X') ? 'macos'
            : navigator.userAgent.includes('Windows') ? 'windows' : 'linux';
        platform.isAppleSilicon = navigator.platform === 'MacIntel' &&
            navigator.userAgent.includes('Mac OS X');
    }

    if (!platform.isAppleSilicon) {
        // Keep Local MLX SELECTABLE — don't hard-block. We highlight a warning
        // when the user picks it (see EngineUiController.updateModeUI) and stop them at Start
        // (see start()) so they can't crash into an unsupported runtime.
        // Local TTS is CPU-based and unaffected; only the MLX engine needs
        // macOS Apple Silicon.
        const select = document.getElementById('select-translation-mode');
        const localOption = select?.querySelector('option[value="local"]');
        if (localOption) {
            // Platform-accurate label: Mac Intel needs Apple Silicon;
            // Windows/Linux aren't supported at all.
            const reason = platform.os === 'macos'
                ? ' — needs an Apple Silicon chip'
                : ' — macOS on Apple Silicon only';
            localOption.textContent += reason;
        }

        // Force soniox mode if user had local selected
        const settings = settingsManager.get();
        if (settings.translation_mode === 'local') {
            settings.translation_mode = 'soniox';
            settingsManager.save(settings);
        }
    }
    return platform;
}
