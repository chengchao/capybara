use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::string::FromUtf8Error;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::Command;
use tokio::process::{Child, ChildStdin, ChildStdout};

const INSTANCE_NAME: &str = "agent";
const SUPERVISOR_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);

const AGENT_YAML: &str = "base: template:default
cpus: 2
memory: 2GiB
disk: 20GiB
ssh:
  loadDotSSHPubKeys: false
  forwardAgent: false
mounts:
  - location: \"~\"
    mountPoint: \"/host-home\"
    writable: true
";

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum VmStatus {
    Starting,
    Running,
    Failed { reason: String },
}

const VM_STATUS_EVENT: &str = "vm-status";

pub struct VmState {
    status: Mutex<VmStatus>,
}

impl Default for VmState {
    fn default() -> Self {
        Self {
            status: Mutex::new(VmStatus::Starting),
        }
    }
}

pub fn emit_status(app: &AppHandle, status: VmStatus) {
    if let Some(state) = app.try_state::<VmState>() {
        *state.status.lock().unwrap() = status.clone();
    }
    let _ = app.emit(VM_STATUS_EVENT, status);
}

#[tauri::command]
pub fn get_vm_status(state: tauri::State<'_, VmState>) -> VmStatus {
    state.status.lock().unwrap().clone()
}

struct LimaPaths {
    limactl: PathBuf,
    lima_home: PathBuf,
    supervisor_source: PathBuf,
    host_home: PathBuf,
}

impl LimaPaths {
    fn resolve(app: &AppHandle) -> Result<Self, VmError> {
        let resource_dir = app.path().resource_dir().map_err(VmError::ResolvePath)?;
        // LIMA_HOME must stay short on macOS: Lima writes `<LIMA_HOME>/<instance>/ssh.sock.<PID>`
        // which is bound by UNIX_PATH_MAX = 104. `~/Library/Application Support/<bundle-id>/lima/`
        // already pushes that to ~107 with a 16-digit PID, so we anchor LIMA_HOME at `~/.capybara/lima`.
        let home_dir = app.path().home_dir().map_err(VmError::ResolvePath)?;
        Ok(Self {
            limactl: resource_dir.join("vendor/lima/bin/limactl"),
            lima_home: home_dir.join(".capybara/lima"),
            supervisor_source: resource_dir.join("resources/supervisor/capybara_supervisor.py"),
            host_home: home_dir,
        })
    }
}

pub async fn ensure_vm(app: &AppHandle) -> Result<(), VmError> {
    let paths = LimaPaths::resolve(app)?;
    emit_status(app, VmStatus::Starting);
    fs_create_dir_all(&paths.lima_home).await?;
    ensure_executable(&paths.limactl)?;

    let list_json = run_limactl(&paths, &["list", "--format=json"]).await?;
    let instances = parse_list_output(&list_json)?;
    let status = instances
        .iter()
        .find(|i| i.name == INSTANCE_NAME)
        .map(|i| i.status.as_str());

    match status {
        Some("Running") => {}
        None => {
            eprintln!("vm: downloading image (first run, this may take a minute)...");
            let yaml_path = paths.lima_home.join(format!("{INSTANCE_NAME}.yaml"));
            fs_write(&yaml_path, AGENT_YAML).await?;
            let yaml_path_str = yaml_path
                .to_str()
                .expect("LIMA_HOME path under home_dir is utf-8 on macOS");
            // The raw host-home mount is a supervisor source path, not a sandbox path.
            // Session commands run through bubblewrap and only see approved subdirs
            // rebound into /mnt/<name>.
            run_limactl(
                &paths,
                &[
                    "create",
                    "--name",
                    INSTANCE_NAME,
                    "--tty=false",
                    yaml_path_str,
                ],
            )
            .await?;
            eprintln!("vm: starting...");
            run_limactl(&paths, &["start", INSTANCE_NAME, "--tty=false"]).await?;
        }
        Some(_) => {
            eprintln!("vm: starting...");
            run_limactl(&paths, &["start", INSTANCE_NAME, "--tty=false"]).await?;
        }
    }

    smoke_test_host_mount(&paths).await?;
    ensure_bwrap(&paths).await?;
    install_supervisor(&paths).await?;
    smoke_test_supervisor(&paths).await?;

    emit_status(app, VmStatus::Running);
    eprintln!("vm: ready");
    Ok(())
}

async fn fs_create_dir_all(path: &Path) -> Result<(), VmError> {
    tokio::fs::create_dir_all(path)
        .await
        .map_err(|source| VmError::Fs {
            path: path.to_path_buf(),
            source,
        })
}

async fn fs_write(path: &Path, contents: &str) -> Result<(), VmError> {
    tokio::fs::write(path, contents)
        .await
        .map_err(|source| VmError::Fs {
            path: path.to_path_buf(),
            source,
        })
}

pub async fn stop_vm(app: &AppHandle) -> Result<(), VmError> {
    let paths = LimaPaths::resolve(app)?;
    eprintln!("vm: stopping...");
    run_limactl(&paths, &["stop", INSTANCE_NAME, "--tty=false"])
        .await
        .map(|_| ())
}

fn ensure_executable(path: &Path) -> Result<(), VmError> {
    let stat = |source| VmError::Stat {
        path: path.to_path_buf(),
        source,
    };

    if !path.try_exists().map_err(stat)? {
        return Err(VmError::Missing(path.to_path_buf()));
    }
    let metadata = path.metadata().map_err(stat)?;
    if !metadata.is_file() {
        return Err(VmError::NotAFile(path.to_path_buf()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(VmError::NotExecutable(path.to_path_buf()));
        }
    }
    Ok(())
}

fn ensure_regular_file(path: &Path) -> Result<(), VmError> {
    let stat = |source| VmError::Stat {
        path: path.to_path_buf(),
        source,
    };

    if !path.try_exists().map_err(stat)? {
        return Err(VmError::Missing(path.to_path_buf()));
    }
    let metadata = path.metadata().map_err(stat)?;
    if !metadata.is_file() {
        return Err(VmError::NotAFile(path.to_path_buf()));
    }
    Ok(())
}

async fn run_limactl(paths: &LimaPaths, args: &[&str]) -> Result<String, VmError> {
    let output = Command::new(&paths.limactl)
        .args(args)
        .env("LIMA_HOME", &paths.lima_home)
        .output()
        .await
        .map_err(VmError::Spawn)?;

    if !output.status.success() {
        return Err(VmError::NonZeroExit {
            code: output.status.code(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }
    String::from_utf8(output.stdout).map_err(VmError::InvalidUtf8)
}

async fn smoke_test_host_mount(paths: &LimaPaths) -> Result<(), VmError> {
    eprintln!("vm: verifying host home mount...");
    // A working virtiofs mount makes the host home visible at /host-home; without it
    // (stale instance config) the path is missing and `test -d` exits non-zero.
    // Distinguish a non-zero exit (mount truly missing) from other failures (limactl
    // crash, ssh hiccup) so unrelated breakage isn't misreported as a mount problem.
    match run_limactl(
        paths,
        &["shell", INSTANCE_NAME, "--", "test", "-d", "/host-home"],
    )
    .await
    {
        Ok(_) => Ok(()),
        Err(VmError::NonZeroExit { .. }) => Err(VmError::HostMountMissing(paths.host_home.clone())),
        Err(other) => Err(other),
    }
}

async fn install_supervisor(paths: &LimaPaths) -> Result<(), VmError> {
    ensure_regular_file(&paths.supervisor_source)?;

    eprintln!("vm: installing supervisor...");
    run_limactl(
        paths,
        &[
            "shell",
            INSTANCE_NAME,
            "--",
            "sudo",
            "mkdir",
            "-p",
            "/opt/capybara",
        ],
    )
    .await?;

    let source = paths
        .supervisor_source
        .to_str()
        .expect("bundled supervisor path is utf-8");
    let destination = format!("{INSTANCE_NAME}:/tmp/capybara_supervisor.py");
    run_limactl(paths, &["copy", source, &destination]).await?;

    run_limactl(
        paths,
        &[
            "shell",
            INSTANCE_NAME,
            "--",
            "sudo",
            "install",
            "-m",
            "0755",
            "/tmp/capybara_supervisor.py",
            "/opt/capybara/supervisor.py",
        ],
    )
    .await?;

    Ok(())
}

async fn ensure_bwrap(paths: &LimaPaths) -> Result<(), VmError> {
    eprintln!("vm: ensuring bubblewrap...");
    run_limactl(
        paths,
        &[
            "shell",
            INSTANCE_NAME,
            "--",
            "sh",
            "-lc",
            "command -v bwrap >/dev/null || (sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y bubblewrap)",
        ],
    )
    .await?;
    run_limactl(paths, &["shell", INSTANCE_NAME, "--", "bwrap", "--version"]).await?;
    Ok(())
}

async fn smoke_test_supervisor(paths: &LimaPaths) -> Result<(), VmError> {
    eprintln!("vm: testing supervisor...");
    let mut client = SupervisorClient::start(paths).await?;
    client.request("ping", json!({})).await?;
    client
        .request("create_session", json!({ "session_id": "smoke_session" }))
        .await?;
    let smoke_result = async {
        let result = client
            .request(
                "run_as_session",
                json!({
                    "session_id": "smoke_session",
                    "cwd": "/workspace",
                    "command": "id -un && pwd",
                    "timeout_ms": 5000,
                }),
            )
            .await?;
        let exit_code = result
            .get("exitCode")
            .and_then(Value::as_i64)
            .ok_or_else(|| VmError::SupervisorProtocol("missing exitCode".into()))?;
        if exit_code != 0 {
            let stderr = result.get("stderr").and_then(Value::as_str).unwrap_or("");
            return Err(VmError::SupervisorProtocol(format!(
                "smoke command failed with {exit_code}: {stderr}"
            )));
        }
        Ok(())
    }
    .await;
    let cleanup_result = client
        .request("delete_session", json!({ "session_id": "smoke_session" }))
        .await;
    client.shutdown().await?;
    smoke_result?;
    cleanup_result?;
    Ok(())
}

struct SupervisorClient {
    child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    next_id: u64,
}

impl SupervisorClient {
    async fn start(paths: &LimaPaths) -> Result<Self, VmError> {
        let mut child = Command::new(&paths.limactl)
            .args([
                "shell",
                INSTANCE_NAME,
                "--",
                "sudo",
                "python3",
                "/opt/capybara/supervisor.py",
            ])
            .env("LIMA_HOME", &paths.lima_home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(VmError::Spawn)?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| VmError::SupervisorProtocol("supervisor stdin unavailable".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| VmError::SupervisorProtocol("supervisor stdout unavailable".into()))?;

        Ok(Self {
            child,
            stdin,
            lines: BufReader::new(stdout).lines(),
            next_id: 0,
        })
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, VmError> {
        self.next_id += 1;
        let id = self.next_id.to_string();
        let request = json!({
            "id": id,
            "method": method,
            "params": params,
        });
        self.stdin
            .write_all(request.to_string().as_bytes())
            .await
            .map_err(VmError::SupervisorIo)?;
        self.stdin
            .write_all(b"\n")
            .await
            .map_err(VmError::SupervisorIo)?;
        self.stdin.flush().await.map_err(VmError::SupervisorIo)?;

        let line = self.lines.next_line();
        let line = tokio::time::timeout(SUPERVISOR_RESPONSE_TIMEOUT, line)
            .await
            .map_err(|_| VmError::SupervisorTimeout)?
            .map_err(VmError::SupervisorIo)?
            .ok_or_else(|| {
                VmError::SupervisorProtocol("supervisor exited without response".into())
            })?;
        let response: SupervisorResponse =
            serde_json::from_str(&line).map_err(VmError::SupervisorJson)?;
        if response.id.as_deref() != Some(&id) {
            return Err(VmError::SupervisorProtocol(format!(
                "response id mismatch: expected {id}, got {:?}",
                response.id
            )));
        }
        if let Some(error) = response.error {
            return Err(VmError::SupervisorProtocol(error.message));
        }
        response
            .result
            .ok_or_else(|| VmError::SupervisorProtocol("response missing result".into()))
    }

    async fn shutdown(mut self) -> Result<(), VmError> {
        let _ = self.request("shutdown", json!({})).await;
        let _ = self.child.wait().await;
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
struct SupervisorResponse {
    id: Option<String>,
    result: Option<Value>,
    error: Option<SupervisorError>,
}

#[derive(Debug, Deserialize)]
struct SupervisorError {
    message: String,
}

#[derive(Debug, Deserialize)]
struct LimaInstance {
    name: String,
    status: String,
}

fn parse_list_output(s: &str) -> Result<Vec<LimaInstance>, VmError> {
    let mut out = Vec::new();
    for (idx, raw) in s.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let instance =
            serde_json::from_str::<LimaInstance>(line).map_err(|source| VmError::Parse {
                line_no: idx + 1,
                snippet: snippet(line),
                source,
            })?;
        out.push(instance);
    }
    Ok(out)
}

fn snippet(line: &str) -> String {
    const MAX: usize = 120;
    if line.len() <= MAX {
        line.to_string()
    } else {
        format!("{}…", &line[..MAX])
    }
}

#[derive(Debug, Error)]
pub enum VmError {
    #[error("could not resolve resource_dir: {0}")]
    ResolvePath(#[source] tauri::Error),

    #[error("could not stat {path}: {source}")]
    Stat {
        path: PathBuf,
        #[source]
        source: io::Error,
    },

    #[error("limactl missing at {0}")]
    Missing(PathBuf),

    #[error("limactl path is not a file: {0}")]
    NotAFile(PathBuf),

    #[error("limactl is not executable: {0}")]
    NotExecutable(PathBuf),

    #[error("filesystem error on {path}: {source}")]
    Fs {
        path: PathBuf,
        #[source]
        source: io::Error,
    },

    #[error("failed to spawn limactl: {0}")]
    Spawn(#[source] io::Error),

    #[error("limactl stdout was not valid utf-8: {0}")]
    InvalidUtf8(#[source] FromUtf8Error),

    #[error("limactl exited {}: {stderr}", display_code(*code))]
    NonZeroExit { code: Option<i32>, stderr: String },

    #[error(
        "host home {0} is not visible inside the VM. The existing instance was created \
         without the mount; delete it and restart:\n    rm -rf ~/.capybara/lima"
    )]
    HostMountMissing(PathBuf),

    #[error("supervisor I/O failed: {0}")]
    SupervisorIo(#[source] io::Error),

    #[error("supervisor response was not valid JSON: {0}")]
    SupervisorJson(#[source] serde_json::Error),

    #[error("supervisor response timed out")]
    SupervisorTimeout,

    #[error("supervisor protocol error: {0}")]
    SupervisorProtocol(String),

    #[error("could not parse `limactl list --format=json` line {line_no}: {source} (snippet: {snippet})")]
    Parse {
        line_no: usize,
        snippet: String,
        #[source]
        source: serde_json::Error,
    },
}

fn display_code(code: Option<i32>) -> String {
    code.map(|c| c.to_string()).unwrap_or_else(|| "?".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_empty_input_returns_empty_vec() {
        assert!(parse_list_output("").unwrap().is_empty());
    }

    #[test]
    fn parse_blank_lines_are_skipped() {
        assert!(parse_list_output("\n\n   \n").unwrap().is_empty());
    }

    #[test]
    fn parse_single_instance_ndjson() {
        let line = r#"{"name":"agent","status":"Running","vmType":"vz"}"#;
        let result = parse_list_output(line).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "agent");
        assert_eq!(result[0].status, "Running");
    }

    #[test]
    fn parse_multiple_ndjson_lines() {
        let input =
            "{\"name\":\"a\",\"status\":\"Stopped\"}\n{\"name\":\"b\",\"status\":\"Running\"}\n";
        let result = parse_list_output(input).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].name, "a");
        assert_eq!(result[1].name, "b");
    }

    #[test]
    fn parse_fails_on_first_malformed_line() {
        let input = "not-json\n{\"name\":\"x\",\"status\":\"Running\"}";
        match parse_list_output(input) {
            Err(VmError::Parse { line_no, .. }) => assert_eq!(line_no, 1),
            other => panic!("expected Parse error on line 1, got {other:?}"),
        }
    }

    #[test]
    fn parse_fails_on_missing_required_field() {
        let input = r#"{"name":"x"}"#;
        match parse_list_output(input) {
            Err(VmError::Parse { line_no: 1, .. }) => {}
            other => panic!("expected Parse error on line 1, got {other:?}"),
        }
    }
}
