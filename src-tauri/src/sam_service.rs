//! Phase 7 roadmap item 2: "the SAM service started by the app itself." Process
//! lifecycle for `sam/sam_service.py` (SAM3 concept detection + SAM2 bidirectional
//! tracking + mask-shape fitting, as a long-lived localhost HTTP service - model
//! loading alone costs ~7s, so this is started once and reused, not spawned per
//! call). No precedent for a long-lived external service elsewhere in this
//! codebase (ffmpeg is always one-shot locate-spawn-wait, every call - see
//! `quiet_command`/`find_ffmpeg` in lib.rs) - own module, own global state, same
//! shape as `mcp_bridge.rs`'s own `OnceLock<Bridge>` rather than threading a new
//! field through `AppState` (this has nothing to do with the project/history/
//! shaped lock ordering `AppState`'s own doc comment calls out).
//!
//! DEV ONLY like everything else this pairs with (`segment_concepts`/
//! `refine_element` in tools.ts) - `python_path`/`script_path` are caller-given,
//! not resolved here: this is a dev feature run from a repo checkout, there's no
//! sensible default location for `sam/` relative to an installed app.
use std::process::Child;
use std::sync::{Mutex, OnceLock};

struct ServiceState {
    child: Mutex<Option<Child>>,
}

fn state() -> &'static ServiceState {
    static S: OnceLock<ServiceState> = OnceLock::new();
    S.get_or_init(|| ServiceState { child: Mutex::new(None) })
}

/// Same no-flashed-console-window trick as lib.rs's own `quiet_command` -
/// duplicated rather than exported, it's six lines and pulling a private helper
/// across a module boundary isn't worth the coupling.
fn quiet_command<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Spawn `python_path script_path port` if no instance is already running (a
/// live child from a prior call is left alone - idempotent, same as
/// `mcp_bridge::start`). Does NOT wait for the model-loading health check to
/// pass (~7s) - the caller polls the service's own `/health` endpoint directly
/// over HTTP (frontend-side fetch, same as every other localhost call this app
/// already makes - see providers.ts's own direct-fetch precedent) rather than
/// block a Tauri command's own synchronous handler on it.
pub fn start(python_path: String, script_path: String, port: u16) -> Result<(), String> {
    let s = state();
    let mut guard = s.child.lock().unwrap();
    if let Some(child) = guard.as_mut() {
        if matches!(child.try_wait(), Ok(None)) {
            return Ok(()); // already running
        }
    }
    // The parent (this app) is windows_subsystem = "windows" - a spawned
    // child's default-inherited stdio goes nowhere visible, which made an
    // early startup failure undiagnosable (the child was alive, burning
    // CPU, and simply never answered /health - no way to tell slow-loading
    // apart from silently stuck). Redirect both streams to a log file next
    // to the script instead - sam_service.log, same name the dev-session's
    // own manual runs already used.
    let log_path = std::path::Path::new(&script_path)
        .parent()
        .map(|d| d.join("sam_service.log"))
        .ok_or_else(|| format!("script_path has no parent directory: {script_path}"))?;
    let log_file = std::fs::File::create(&log_path).map_err(|e| format!("failed to create {}: {e}", log_path.display()))?;
    let log_file_err = log_file.try_clone().map_err(|e| format!("failed to clone log handle: {e}"))?;
    let child = quiet_command(&python_path)
        .arg(&script_path)
        .arg(port.to_string())
        .stdout(log_file)
        .stderr(log_file_err)
        .spawn()
        .map_err(|e| format!("failed to start sam_service ({python_path} {script_path} {port}): {e}"))?;
    *guard = Some(child);
    Ok(())
}

/// Whether a spawned instance is still alive (not whether it's finished
/// loading models / answering `/health` - that's the caller's own HTTP poll).
pub fn is_running() -> bool {
    let s = state();
    let mut guard = s.child.lock().unwrap();
    match guard.as_mut() {
        Some(child) => matches!(child.try_wait(), Ok(None)),
        None => false,
    }
}

/// Kill the running instance, if any. Best-effort: GPU memory it was holding
/// is released when the process actually exits, which this doesn't wait for.
pub fn stop() -> Result<(), String> {
    let s = state();
    let mut guard = s.child.lock().unwrap();
    if let Some(mut child) = guard.take() {
        child.kill().map_err(|e| format!("failed to stop sam_service: {e}"))?;
    }
    Ok(())
}
