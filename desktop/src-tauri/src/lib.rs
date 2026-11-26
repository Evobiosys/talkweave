// talkweave desktop shell — Tauri v2 thin wrapper around the existing Node
// server + Svelte app. This crate owns exactly three things: finding a
// Node binary, spawning `node server/server.mjs` against the bundled
// resources with sessions pointed at the macOS App Support dir, and
// showing a window on http://127.0.0.1:8990 once /api/health answers. No
// server/app logic is ported or duplicated here.
//
// TALKWEAVE_HEADLESS_CHECK=1 runs the spawn-and-health-check logic and
// exits without ever touching the Tauri GUI machinery — that's the only
// way this binary may be run during agent verification (see
// project plan: no window may be opened by the agent).

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const HOST: &str = "127.0.0.1";
const PORT: u16 = 8990;
const HEALTH_PATH: &str = "/api/health";
const HEALTH_TIMEOUT: Duration = Duration::from_secs(10);
const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(200);
const CONNECT_TIMEOUT: Duration = Duration::from_millis(400);

/// Outcome of getting a healthy server ready to serve the app: either we
/// found one already answering (and must never touch it), or we spawned
/// one ourselves (and own its lifecycle).
enum ServerHandle {
    Reused,
    Spawned(Child),
}

/// Locates the bundled resources root (server/, app/dist/, landing/).
/// Computed from `current_exe()` rather than Tauri's path resolver so this
/// works identically whether the binary is launched by LaunchServices or
/// executed directly by absolute path (the only way agent verification
/// may run it — see module doc). Tries the macOS app-bundle convention
/// first (`Contents/MacOS/<exe>` -> `Contents/Resources`), then falls back
/// to the exe's own directory, which is where `cargo build`/`cargo run`
/// (via tauri-build's dev-resource copy) places them — this makes plain
/// `cargo run` usable for local iteration without a full `tauri build`.
fn resource_root() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let exe_dir = exe.parent().ok_or("exe has no parent dir")?.to_path_buf();

    if let Some(contents_dir) = exe_dir.parent() {
        let bundle_resources = contents_dir.join("Resources");
        if bundle_resources.join("server").join("server.mjs").is_file() {
            return Ok(bundle_resources);
        }
    }

    if exe_dir.join("server").join("server.mjs").is_file() {
        return Ok(exe_dir);
    }

    Err(format!(
        "could not locate bundled resources (server/server.mjs) near exe at {exe:?}"
    ))
}

fn home_dir() -> Result<PathBuf, String> {
    std::env::var("HOME")
        .map(PathBuf::from)
        .map_err(|_| "HOME is not set".to_string())
}

fn sessions_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?
        .join("Library")
        .join("Application Support")
        .join("TalkWeave")
        .join("sessions"))
}

fn log_file_path() -> Result<PathBuf, String> {
    Ok(home_dir()?.join("Library").join("Logs").join("talkweave.log"))
}

/// Resolves the Node binary: `TALKWEAVE_NODE` env override, then the two
/// well-known Homebrew/local install paths, then `which node` on PATH.
/// Order and candidates are fixed by the plan. An explicitly-set
/// `TALKWEAVE_NODE` that doesn't point at a real file is a hard error, not
/// a silent fall-through to the other candidates — the user asked for a
/// specific binary and it isn't there.
fn resolve_node_binary() -> Result<PathBuf, String> {
    if let Ok(from_env) = std::env::var("TALKWEAVE_NODE") {
        if !from_env.trim().is_empty() {
            let p = PathBuf::from(&from_env);
            if p.is_file() {
                return Ok(p);
            }
            return Err(format!(
                "TALKWEAVE_NODE is set to {p:?} but that is not a file; unset it or point it at a real Node binary"
            ));
        }
    }

    for candidate in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] {
        let p = PathBuf::from(candidate);
        if p.is_file() {
            return Ok(p);
        }
    }

    let output = Command::new("which")
        .arg("node")
        .output()
        .map_err(|e| format!("`which node` failed to run: {e}"))?;
    if output.status.success() {
        let path_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !path_str.is_empty() {
            let p = PathBuf::from(path_str);
            if p.is_file() {
                return Ok(p);
            }
        }
    }

    Err("no Node binary found (checked TALKWEAVE_NODE, /opt/homebrew/bin/node, /usr/local/bin/node, `which node`)".to_string())
}

/// One blocking GET to `/api/health`, true iff the response's status line
/// is 200. Hand-rolled over a raw TCP socket (no HTTP client crate) to
/// keep this shell's dependencies to what Tauri itself needs.
fn check_health() -> bool {
    let stream = match TcpStream::connect_timeout(
        &format!("{HOST}:{PORT}").parse().expect("static host:port parses"),
        CONNECT_TIMEOUT,
    ) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(CONNECT_TIMEOUT));
    let _ = stream.set_write_timeout(Some(CONNECT_TIMEOUT));
    let mut stream = stream;
    let request = format!("GET {HEALTH_PATH} HTTP/1.1\r\nHost: {HOST}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 64];
    let n = match stream.read(&mut buf) {
        Ok(n) => n,
        Err(_) => return false,
    };
    let text = String::from_utf8_lossy(&buf[..n]);
    text.starts_with("HTTP/1.1 200") || text.starts_with("HTTP/1.0 200")
}

fn poll_health_until_ready(timeout: Duration) -> bool {
    let start = Instant::now();
    loop {
        if check_health() {
            return true;
        }
        if start.elapsed() >= timeout {
            return false;
        }
        std::thread::sleep(HEALTH_POLL_INTERVAL);
    }
}

/// Spawns `node server/server.mjs` with cwd = the bundled resources root
/// (so the server's own relative paths to app/dist and landing/ resolve),
/// sessions pointed at the App Support dir, and stdout/stderr appended to
/// the same log path the old shell-script launcher used.
fn spawn_server(node_bin: &Path, resources_root: &Path, sessions_dir: &Path, log_path: &Path) -> Result<Child, String> {
    fs::create_dir_all(sessions_dir).map_err(|e| format!("failed to create sessions dir {sessions_dir:?}: {e}"))?;
    if let Some(log_dir) = log_path.parent() {
        fs::create_dir_all(log_dir).map_err(|e| format!("failed to create log dir {log_dir:?}: {e}"))?;
    }

    let server_entry = resources_root.join("server").join("server.mjs");
    if !server_entry.is_file() {
        return Err(format!("bundled server entry not found at {server_entry:?}"));
    }

    let stdout_file = open_log_for_append(log_path)?;
    let stderr_file = open_log_for_append(log_path)?;

    Command::new(node_bin)
        .arg("server/server.mjs")
        .current_dir(resources_root)
        .env("TALKWEAVE_SESSIONS_DIR", sessions_dir)
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file))
        .spawn()
        .map_err(|e| format!("failed to spawn {node_bin:?} server/server.mjs: {e}"))
}

fn open_log_for_append(log_path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map_err(|e| format!("failed to open log file {log_path:?}: {e}"))
}

const STARTUP_FAILURE_HINT: &str = "Install Node or set TALKWEAVE_NODE; see ~/Library/Logs/talkweave.log";

/// `date '+%Y-%m-%d %H:%M:%S'`, matching the old shell-script launcher's log
/// timestamp format. Shelled out rather than hand-rolling calendar math or
/// adding a time crate — this only runs on a startup-failure path, not
/// per-request.
fn timestamp() -> String {
    Command::new("date")
        .arg("+%Y-%m-%d %H:%M:%S")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown-time".to_string())
}

/// Best-effort append of a timestamped parent-side diagnostic to
/// ~/Library/Logs/talkweave.log — the same file the spawned Node child's
/// stdout/stderr already go to, so a failed launch leaves one coherent
/// trail instead of only the child's half. Never panics: a logging failure
/// must not prevent the caller from still exiting/alerting.
fn log_startup_diagnostic(message: &str) {
    let Ok(log_path) = log_file_path() else { return };
    if let Some(dir) = log_path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&log_path) {
        let _ = writeln!(f, "{} talkweave: STARTUP FAILURE: {message}", timestamp());
    }
}

/// Escapes `message` so it can be embedded as an AppleScript double-quoted
/// string literal. `Command` passes this straight to `osascript -e <arg>`
/// with no shell in between, so shell metacharacters are never a concern —
/// only AppleScript string-literal syntax is. That means: `\` and `"` need
/// backslash-escaping, and — easy to miss, and the reason this function
/// exists as its own unit rather than being inlined — a literal newline
/// byte inside the source text breaks the AppleScript statement (source is
/// line-based; a raw `\n` mid-string is a syntax error, not a value), so
/// `\n`/`\r` bytes must become the two-character escape sequences `\n`/`\r`
/// (AppleScript string literals interpret those as an actual
/// newline/return at runtime, same as C). Escaping the bare backslash
/// first means the backslashes this function itself inserts for `\r`/`\n`
/// never get double-escaped by a later step.
fn applescript_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\r', "\\r")
        .replace('\n', "\\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applescript_escape_handles_quotes_backslashes_and_newlines() {
        let input = "line one\nhas a \"quote\" and a \\backslash\\\r\nline two";
        let escaped = applescript_escape(input);

        // No raw newline/carriage-return bytes may survive — those are what
        // broke osascript parsing (fix round 2).
        assert!(!escaped.contains('\n'), "escaped text must not contain a raw newline byte: {escaped:?}");
        assert!(!escaped.contains('\r'), "escaped text must not contain a raw carriage-return byte: {escaped:?}");

        assert_eq!(
            escaped,
            "line one\\nhas a \\\"quote\\\" and a \\\\backslash\\\\\\r\\nline two"
        );

        // The escaped text, dropped into a `display alert ... message "<here>"`
        // AppleScript source string, must compile (osacompile), proving this
        // is valid AppleScript source and not just "looks escaped" — run
        // without ever opening a dialog (osacompile only parses/compiles).
        let script = format!("display alert \"t\" message \"{escaped}\" as critical");
        let dir = std::env::temp_dir();
        let src_path = dir.join(format!("tw_alert_test_{}.applescript", std::process::id()));
        let compiled_path = dir.join(format!("tw_alert_test_{}.scpt", std::process::id()));
        fs::write(&src_path, &script).expect("write temp applescript source");

        let status = Command::new("osacompile")
            .arg("-o")
            .arg(&compiled_path)
            .arg(&src_path)
            .status()
            .expect("run osacompile");

        let _ = fs::remove_file(&src_path);
        let _ = fs::remove_file(&compiled_path);

        assert!(status.success(), "osacompile must accept the escaped script:\n{script}");
    }
}

/// Shows a native macOS alert with `message` plus the standard
/// install/log-location hint, via `osascript -e 'display alert ...'` — no
/// new crate for a dialog box. Caller is responsible for not calling this
/// under `TALKWEAVE_HEADLESS_CHECK` (see `report_startup_failure`).
fn show_startup_alert(message: &str) {
    let body = applescript_escape(&format!("{message}\n\n{STARTUP_FAILURE_HINT}"));
    let script = format!("display alert \"TalkWeave failed to start\" message \"{body}\" as critical");
    let _ = Command::new("osascript").arg("-e").arg(script).status();
}

/// Single surface for every startup-failure diagnostic: always logged to
/// ~/Library/Logs/talkweave.log (so a Finder-launched app that just bounces
/// and vanishes still leaves a trail), and shown as a native alert unless
/// `TALKWEAVE_HEADLESS_CHECK` is set (agent verification must stay
/// windowless).
fn report_startup_failure(message: &str) {
    log_startup_diagnostic(message);
    if std::env::var("TALKWEAVE_HEADLESS_CHECK").is_err() {
        show_startup_alert(message);
    }
}

/// Full "get a healthy server" flow: reuse one already answering (never
/// spawned by us, never killed by us), otherwise resolve Node, spawn our
/// own, and poll until healthy or the 10s budget runs out.
fn ensure_server_ready(resources_root: &Path) -> Result<ServerHandle, String> {
    if check_health() {
        return Ok(ServerHandle::Reused);
    }

    let node_bin = resolve_node_binary()?;
    let sessions_dir = sessions_dir()?;
    let log_path = log_file_path()?;
    let mut child = spawn_server(&node_bin, resources_root, &sessions_dir, &log_path)?;

    if poll_health_until_ready(HEALTH_TIMEOUT) {
        Ok(ServerHandle::Spawned(child))
    } else {
        let _ = child.kill();
        let _ = child.wait();
        Err(format!(
            "server did not become healthy within {:?} (see {log_path:?})",
            HEALTH_TIMEOUT
        ))
    }
}

/// `TALKWEAVE_HEADLESS_CHECK=1` path: prove spawn -> health -> exit works
/// and leaves no listener behind, without ever constructing a Tauri
/// Builder (so no GUI/window subsystem is touched at all). Never run this
/// binary without this flag during agent verification.
fn run_headless_check() -> ! {
    let outcome = resource_root().and_then(|root| ensure_server_ready(&root));
    match outcome {
        Ok(ServerHandle::Reused) => {
            println!("TALKWEAVE_HEADLESS_CHECK: OK (reused an already-healthy server; not spawned by us, not killed)");
            std::process::exit(0);
        }
        Ok(ServerHandle::Spawned(mut child)) => {
            println!("TALKWEAVE_HEADLESS_CHECK: OK (spawned, healthy)");
            let _ = child.kill();
            let _ = child.wait();
            std::process::exit(0);
        }
        Err(e) => {
            report_startup_failure(&e);
            eprintln!("TALKWEAVE_HEADLESS_CHECK: FAIL: {e}");
            std::process::exit(1);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if std::env::var("TALKWEAVE_HEADLESS_CHECK").is_ok() {
        run_headless_check();
    }

    let resources_root = resource_root().expect("failed to resolve bundled resources root");
    let outcome = ensure_server_ready(&resources_root);

    let spawned_child: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    match outcome {
        Ok(ServerHandle::Reused) => {
            // Not spawned by us -> spawned_child stays None -> never killed on exit.
        }
        Ok(ServerHandle::Spawned(child)) => {
            *spawned_child.lock().expect("lock poisoned") = Some(child);
        }
        Err(e) => {
            report_startup_failure(&e);
            eprintln!("talkweave: failed to start server: {e}");
            std::process::exit(1);
        }
    }

    let kill_on_exit = spawned_child.clone();

    let app = tauri::Builder::default()
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    if cfg!(debug_assertions) {
        app.handle()
            .plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .build(),
            )
            .expect("failed to register log plugin");
    }

    let url = format!("http://{HOST}:{PORT}").parse().expect("static url parses");
    tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::External(url))
        .title("TalkWeave")
        .inner_size(1200.0, 820.0)
        .min_inner_size(760.0, 560.0)
        .build()
        .expect("failed to create main window");

    app.run(move |_app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Ok(mut guard) = kill_on_exit.lock() {
                if let Some(mut child) = guard.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    });
}
