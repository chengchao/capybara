use std::io;
use std::path::{Path, PathBuf};
use std::string::FromUtf8Error;

use serde::Deserialize;
use tauri::{AppHandle, Manager};
use thiserror::Error;
use tokio::process::Command;
use tokio::try_join;

pub async fn smoke_test(app: &AppHandle) -> Result<(), VmError> {
    let limactl = resolve_limactl(app)?;
    eprintln!("lima: resolved limactl at {}", limactl.display());

    ensure_executable(&limactl)?;

    let (version, list_json) = try_join!(
        run_limactl(&limactl, &["--version"]),
        run_limactl(&limactl, &["list", "--format=json"]),
    )?;
    eprintln!("lima --version: {}", version.trim());

    let instances = parse_list_output(&list_json)?;
    eprintln!("lima list (parsed): {} instance(s)", instances.len());

    Ok(())
}

fn resolve_limactl(app: &AppHandle) -> Result<PathBuf, VmError> {
    let resource_dir = app.path().resource_dir().map_err(VmError::ResolvePath)?;
    Ok(resource_dir.join("vendor/lima/bin/limactl"))
}

fn ensure_executable(path: &Path) -> Result<(), VmError> {
    let stat = |source| VmError::Stat { path: path.to_path_buf(), source };

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

async fn run_limactl(limactl: &Path, args: &[&str]) -> Result<String, VmError> {
    let output = Command::new(limactl)
        .args(args)
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

    #[error("failed to spawn limactl: {0}")]
    Spawn(#[source] io::Error),

    #[error("limactl stdout was not valid utf-8: {0}")]
    InvalidUtf8(#[source] FromUtf8Error),

    #[error("limactl exited {}: {stderr}", display_code(*code))]
    NonZeroExit { code: Option<i32>, stderr: String },

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
