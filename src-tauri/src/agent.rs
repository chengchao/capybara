use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use thiserror::Error;
use tokio::sync::Mutex;

const AGENT_EVENT: &str = "agent-event";
const AGENT_JS_RESOURCE: &str = "resources/capybara-agent/index.js";
const BUN_SIDECAR: &str = "bun";
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Default)]
pub struct AgentState {
    process: Mutex<Option<AgentProcess>>,
    shutting_down: AtomicBool,
}

struct AgentProcess {
    child: CommandChild,
}

#[tauri::command]
pub async fn start_agent_task(
    app: AppHandle,
    state: State<'_, AgentState>,
    prompt: String,
) -> Result<(), String> {
    if prompt.trim().is_empty() {
        return Err("prompt is required".into());
    }

    let mut guard = state.process.lock().await;
    if guard.is_none() {
        *guard = Some(start_agent(&app).await.map_err(|e| e.to_string())?);
    }

    let process = guard
        .as_mut()
        .ok_or_else(|| "agent process was not started".to_string())?;
    if let Err(error) = process.write_request(json!({
        "method": "start_task",
        "params": { "prompt": prompt },
    })) {
        guard.take();
        return Err(error.to_string());
    }

    Ok(())
}

pub async fn stop_agent(app: &AppHandle) {
    let Some(state) = app.try_state::<AgentState>() else {
        return;
    };
    state.shutting_down.store(true, Ordering::Relaxed);

    let mut guard = state.process.lock().await;
    let Some(mut process) = guard.take() else {
        return;
    };

    let _ = process.write_request(json!({
        "method": "shutdown",
        "params": {},
    }));

    tokio::time::sleep(SHUTDOWN_TIMEOUT).await;
    let _ = process.child.kill();
}

async fn start_agent(app: &AppHandle) -> Result<AgentProcess, AgentError> {
    let paths = AgentPaths::resolve(app)?;
    ensure_file(&paths.agent_js)?;

    let (mut rx, child) = app
        .shell()
        .sidecar(BUN_SIDECAR)
        .map_err(AgentError::Shell)?
        .arg(&paths.agent_js)
        .spawn()
        .map_err(AgentError::Shell)?;

    let event_app = app.clone();
    tokio::spawn(async move {
        let mut stdout_buffer = AgentLineBuffer::default();
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    for line in stdout_buffer.push(&bytes) {
                        emit_agent_line(&event_app, &line);
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    eprintln!("agent: {}", String::from_utf8_lossy(&bytes));
                }
                CommandEvent::Error(error) => {
                    eprintln!("agent: {error}");
                }
                CommandEvent::Terminated(status) => {
                    let shutting_down = event_app
                        .try_state::<AgentState>()
                        .map(|state| state.shutting_down.load(Ordering::Relaxed))
                        .unwrap_or(false);
                    let _ = event_app.emit(
                        AGENT_EVENT,
                        json!({
                            "event": "agent_exited",
                            "code": status.code,
                            "signal": status.signal,
                        }),
                    );
                    if !shutting_down {
                        event_app.exit(1);
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(AgentProcess { child })
}

#[derive(Default)]
struct AgentLineBuffer {
    pending: String,
}

impl AgentLineBuffer {
    fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.pending.push_str(&String::from_utf8_lossy(bytes));

        let mut lines = Vec::new();
        while let Some(newline) = self.pending.find('\n') {
            let line: String = self.pending.drain(..=newline).collect();
            lines.push(line.trim_end_matches('\n').to_string());
        }
        lines
    }
}

fn emit_agent_line(app: &AppHandle, line: &str) {
    if line.trim().is_empty() {
        return;
    }

    match serde_json::from_str::<Value>(line) {
        Ok(value) => {
            let _ = app.emit(AGENT_EVENT, value);
        }
        Err(error) => {
            let _ = app.emit(
                AGENT_EVENT,
                json!({
                    "event": "agent_protocol_error",
                    "error": error.to_string(),
                    "line": line,
                }),
            );
        }
    }
}

impl AgentProcess {
    fn write_request(&mut self, request: Value) -> Result<(), AgentError> {
        let mut line = request.to_string();
        line.push('\n');
        self.child.write(line.as_bytes()).map_err(AgentError::Shell)
    }
}

struct AgentPaths {
    agent_js: PathBuf,
}

impl AgentPaths {
    fn resolve(_app: &AppHandle) -> Result<Self, AgentError> {
        #[cfg(debug_assertions)]
        let agent_js = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(AGENT_JS_RESOURCE);
        #[cfg(not(debug_assertions))]
        let agent_js = _app
            .path()
            .resolve(AGENT_JS_RESOURCE, tauri::path::BaseDirectory::Resource)
            .map_err(AgentError::ResolvePath)?;

        Ok(Self { agent_js })
    }
}

fn ensure_file(path: &std::path::Path) -> Result<(), AgentError> {
    let metadata = path.metadata().map_err(|source| AgentError::Stat {
        path: path.into(),
        source,
    })?;
    if !metadata.is_file() {
        return Err(AgentError::NotAFile(path.into()));
    }
    Ok(())
}

#[derive(Debug, Error)]
enum AgentError {
    #[cfg(not(debug_assertions))]
    #[error("could not resolve resource_dir: {0}")]
    ResolvePath(#[source] tauri::Error),

    #[error("could not stat {path}: {source}")]
    Stat {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("agent path is not a file: {0}")]
    NotAFile(PathBuf),

    #[error("agent sidecar failed: {0}")]
    Shell(#[source] tauri_plugin_shell::Error),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_buffer_returns_complete_line() {
        let mut buffer = AgentLineBuffer::default();
        assert_eq!(buffer.push(br#"{"event":"ready"}"#), Vec::<String>::new());
        assert_eq!(buffer.push(b"\n"), vec![r#"{"event":"ready"}"#]);
    }

    #[test]
    fn line_buffer_handles_split_line() {
        let mut buffer = AgentLineBuffer::default();
        assert!(buffer.push(br#"{"event":"task_"#).is_empty());
        assert_eq!(
            buffer.push(br#"started","taskId":"1"}"#),
            Vec::<String>::new()
        );
        assert_eq!(
            buffer.push(b"\n"),
            vec![r#"{"event":"task_started","taskId":"1"}"#]
        );
    }

    #[test]
    fn line_buffer_handles_multiple_lines_in_one_chunk() {
        let mut buffer = AgentLineBuffer::default();
        assert_eq!(
            buffer.push(b"{\"event\":\"one\"}\n{\"event\":\"two\"}\n"),
            vec![r#"{"event":"one"}"#, r#"{"event":"two"}"#]
        );
    }

    #[test]
    fn line_buffer_keeps_trailing_partial_line() {
        let mut buffer = AgentLineBuffer::default();
        assert_eq!(
            buffer.push(b"{\"event\":\"one\"}\n{\"event\":\"two\""),
            vec![r#"{"event":"one"}"#]
        );
        assert_eq!(buffer.push(b"}\n"), vec![r#"{"event":"two"}"#]);
    }
}
