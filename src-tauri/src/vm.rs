use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tokio::process::Command;

pub async fn smoke_test(app: &AppHandle) -> Result<(), VmError> {
    let limactl = resolve_limactl(app)?;
    eprintln!("lima: resolved limactl at {}", limactl.display());

    ensure_executable(&limactl)?;

    let version = run_limactl(&limactl, &["--version"]).await?;
    eprintln!("lima --version: {}", version.trim());

    let list_json = run_limactl(&limactl, &["list", "--format=json"]).await?;
    let instances = parse_list_output(&list_json)?;
    eprintln!("lima list (parsed): {} instance(s)", instances.len());

    Ok(())
}

fn resolve_limactl(app: &AppHandle) -> Result<PathBuf, VmError> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| VmError::ResolvePath(e.to_string()))?;
    Ok(resource_dir.join("vendor/lima/bin/limactl"))
}

fn ensure_executable(path: &Path) -> Result<(), VmError> {
    let exists = path
        .try_exists()
        .map_err(|e| VmError::Stat(path.to_path_buf(), e.to_string()))?;
    if !exists {
        return Err(VmError::Missing(path.to_path_buf()));
    }
    let metadata = path
        .metadata()
        .map_err(|e| VmError::Stat(path.to_path_buf(), e.to_string()))?;
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

async fn run_limactl(limactl: &Path, args: &[&str]) -> Result<String, VmError> {
    let output = Command::new(limactl)
        .args(args)
        .output()
        .await
        .map_err(|e| VmError::Spawn(e.to_string()))?;

    if !output.status.success() {
        return Err(VmError::NonZeroExit {
            code: output.status.code(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }
    String::from_utf8(output.stdout)
        .map_err(|e| VmError::Spawn(format!("limactl stdout was not valid utf-8: {e}")))
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
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
        let instance = serde_json::from_str::<LimaInstance>(line).map_err(|source| {
            VmError::Parse {
                line_no: idx + 1,
                snippet: snippet(line),
                source: source.to_string(),
            }
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

#[derive(Debug)]
pub enum VmError {
    ResolvePath(String),
    Stat(PathBuf, String),
    Missing(PathBuf),
    NotAFile(PathBuf),
    NotExecutable(PathBuf),
    Spawn(String),
    NonZeroExit { code: Option<i32>, stderr: String },
    Parse { line_no: usize, snippet: String, source: String },
}

impl std::fmt::Display for VmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VmError::ResolvePath(e) => write!(f, "could not resolve resource_dir: {e}"),
            VmError::Stat(p, e) => write!(f, "could not stat {}: {e}", p.display()),
            VmError::Missing(p) => write!(f, "limactl missing at {}", p.display()),
            VmError::NotAFile(p) => write!(f, "limactl path is not a file: {}", p.display()),
            VmError::NotExecutable(p) => {
                write!(f, "limactl is not executable: {}", p.display())
            }
            VmError::Spawn(e) => write!(f, "failed to spawn limactl: {e}"),
            VmError::NonZeroExit { code, stderr } => {
                let code = code.map(|c| c.to_string()).unwrap_or_else(|| "?".into());
                write!(f, "limactl exited {code}: {stderr}")
            }
            VmError::Parse { line_no, snippet, source } => write!(
                f,
                "could not parse `limactl list --format=json` line {line_no}: {source} (snippet: {snippet})"
            ),
        }
    }
}

impl std::error::Error for VmError {}

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
        let input = "{\"name\":\"a\",\"status\":\"Stopped\"}\n{\"name\":\"b\",\"status\":\"Running\"}\n";
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
