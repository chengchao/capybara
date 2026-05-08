#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import signal
import stat
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, Dict, cast


SESSION_RE = re.compile(r"^[a-z][a-z0-9_-]{0,22}$")
MOUNT_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
STATE_ROOT = "/var/lib/capybara/sessions"
HOST_ROOT = "/host-home"
SANDBOX_HOME = "/home/capybara"
SANDBOX_WORK = "/workspace"
JsonDict = Dict[str, Any]


def log(*parts: object) -> None:
    print("supervisor:", *parts, file=sys.stderr, flush=True)


def validate_session_id(session_id: str) -> None:
    if not SESSION_RE.fullmatch(session_id):
        raise ValueError("invalid session_id")


def validate_mount_name(name: str) -> None:
    if not MOUNT_NAME_RE.fullmatch(name):
        raise ValueError("invalid mount_name")


def user_for_session(session_id: str) -> str:
    validate_session_id(session_id)
    return f"capybara_{session_id}"


def group_for_session(session_id: str) -> str:
    validate_session_id(session_id)
    return f"capybara_{session_id}"


def session_root(session_id: str) -> str:
    validate_session_id(session_id)
    return os.path.join(STATE_ROOT, session_id)


def session_home(session_id: str) -> str:
    return os.path.join(session_root(session_id), "home")


def session_work(session_id: str) -> str:
    return os.path.join(session_root(session_id), "work")


def mounts_path(session_id: str) -> str:
    return os.path.join(session_root(session_id), "mounts.json")


def run(argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, text=True, capture_output=True, check=True, **kwargs)


def ensure_directory(path: str) -> None:
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        run(["mkdir", "-p", path])
        return
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
        raise RuntimeError(f"{path} must be a directory")


def ensure_file(path: str, contents: str) -> None:
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        Path(path).write_text(contents)
        return
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
        raise RuntimeError(f"{path} must be a regular file")


def chmod_chown(path: str, owner: str, mode: str) -> None:
    run(["chown", owner, path])
    run(["chmod", mode, path])


def uid_for_user(user: str) -> int:
    return int(subprocess.check_output(["id", "-u", user], text=True).strip())


def group_exists(group: str) -> bool:
    return subprocess.run(["getent", "group", group], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def user_exists(user: str) -> bool:
    return subprocess.run(["id", "-u", user], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def parse_timeout_ms(value: object) -> int:
    if not isinstance(value, (int, float, str)):
        raise ValueError("timeout_ms must be a number")
    timeout_ms = int(value)
    if timeout_ms <= 0:
        raise ValueError("timeout_ms must be positive")
    return timeout_ms


def signal_user_processes(user: str, sig: signal.Signals) -> None:
    try:
        uid = uid_for_user(user)
    except subprocess.CalledProcessError:
        return

    current_pid = os.getpid()
    for status_path in list(Path("/proc").glob("[0-9]*/status")):
        pid = int(status_path.parent.name)
        if pid == current_pid:
            continue
        try:
            status = status_path.read_text()
        except OSError:
            continue
        if f"Uid:\t{uid}\t" not in status:
            continue
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            continue


def wait_user_processes_gone(user: str, timeout_seconds: float) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if not has_user_processes(user):
            return True
        time.sleep(0.05)
    return not has_user_processes(user)


def has_user_processes(user: str) -> bool:
    try:
        uid = uid_for_user(user)
    except subprocess.CalledProcessError:
        return False

    current_pid = os.getpid()
    for status_path in list(Path("/proc").glob("[0-9]*/status")):
        pid = int(status_path.parent.name)
        if pid == current_pid:
            continue
        try:
            status = status_path.read_text()
        except OSError:
            continue
        if f"Uid:\t{uid}\t" in status:
            return True
    return False


def signal_process_group(proc: subprocess.Popen[str], sig: signal.Signals) -> None:
    try:
        os.killpg(proc.pid, sig)
    except ProcessLookupError:
        pass


def collect_process_output(proc: subprocess.Popen[str], timeout_seconds: float = 2) -> tuple[str, str]:
    try:
        return proc.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        return "", "command output collection timed out\n"


def terminate_session_command(proc: subprocess.Popen[str], user: str) -> tuple[str, str]:
    signal_process_group(proc, signal.SIGTERM)
    try:
        stdout, stderr = proc.communicate(timeout=1)
    except subprocess.TimeoutExpired:
        signal_process_group(proc, signal.SIGKILL)
        signal_user_processes(user, signal.SIGKILL)
        wait_user_processes_gone(user, 1)
        stdout, stderr = collect_process_output(proc)
    return stdout, stderr


def kill_session_processes(user: str) -> None:
    signal_user_processes(user, signal.SIGTERM)
    if wait_user_processes_gone(user, 1):
        return

    signal_user_processes(user, signal.SIGKILL)
    if not wait_user_processes_gone(user, 1):
        raise RuntimeError(f"failed to kill session processes for {user}")


def load_mounts(session_id: str) -> dict[str, dict[str, Any]]:
    path = mounts_path(session_id)
    try:
        data = json.loads(Path(path).read_text())
    except FileNotFoundError:
        raise ValueError("session does not exist") from None
    if not isinstance(data, dict):
        raise RuntimeError("mounts.json must contain an object")
    for name, value in data.items():
        validate_mount_name(name)
        if not isinstance(value, dict):
            raise RuntimeError("mounts.json entries must be objects")
        source = value.get("source")
        writable = value.get("writable")
        if not isinstance(source, str) or not isinstance(writable, bool):
            raise RuntimeError("mounts.json entry is invalid")
    return cast(dict[str, dict[str, Any]], data)


def store_mounts(session_id: str, mounts: dict[str, dict[str, Any]]) -> None:
    path = mounts_path(session_id)
    tmp_path = f"{path}.tmp"
    Path(tmp_path).write_text(json.dumps(mounts, sort_keys=True, indent=2) + "\n")
    chmod_chown(tmp_path, "root:root", "600")
    os.replace(tmp_path, path)


def path_under(needle: str, root: str) -> bool:
    return needle == root or needle.startswith(root + os.sep)


def resolve_host_path(path: str) -> str:
    if not os.path.isabs(path):
        raise ValueError("host_path must be absolute")
    resolved = os.path.realpath(path)
    if not path_under(resolved, os.path.realpath(HOST_ROOT)):
        raise ValueError("host_path outside host root")
    if not os.path.isdir(resolved):
        raise ValueError("host_path must be an existing directory")
    return resolved


def resolved_resolv_conf() -> str:
    # On systemd-resolved hosts /etc/resolv.conf is a symlink into
    # /run/systemd/resolve/, which bwrap's --ro-bind /etc carries through but
    # whose target isn't bound inside the sandbox — the link would dangle and
    # DNS would silently break. Bind the resolved file separately over
    # /etc/resolv.conf so the sandbox sees a working resolver config.
    resolved = os.path.realpath("/etc/resolv.conf")
    if not os.path.isfile(resolved):
        raise RuntimeError(f"resolved resolv.conf is not a file: {resolved}")
    return resolved


def validate_sandbox_cwd(cwd: object) -> str:
    if cwd is None:
        return SANDBOX_WORK
    if not isinstance(cwd, str) or not cwd.startswith("/"):
        raise ValueError("cwd must be an absolute sandbox path")
    allowed = (SANDBOX_WORK, SANDBOX_HOME, "/tmp", "/mnt")
    if not any(path_under(cwd, root) for root in allowed):
        raise ValueError("cwd outside sandbox writable roots")
    if ".." in Path(cwd).parts:
        raise ValueError("cwd must not contain ..")
    return cwd


def bwrap_args(session_id: str, cwd: str) -> list[str]:
    args = [
        "bwrap",
        "--new-session",
        "--die-with-parent",
        "--unshare-pid",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--ro-bind",
        "/usr",
        "/usr",
        "--ro-bind",
        "/bin",
        "/bin",
        "--ro-bind",
        "/lib",
        "/lib",
        "--ro-bind-try",
        "/lib64",
        "/lib64",
        "--ro-bind",
        "/etc",
        "/etc",
        "--ro-bind",
        resolved_resolv_conf(),
        "/etc/resolv.conf",
        "--dir",
        "/home",
        "--bind",
        session_home(session_id),
        SANDBOX_HOME,
        "--bind",
        session_work(session_id),
        SANDBOX_WORK,
        "--dir",
        "/mnt",
    ]

    for name, mount in sorted(load_mounts(session_id).items()):
        target = f"/mnt/{name}"
        source = resolve_host_path(cast(str, mount["source"]))
        args.extend(["--dir", target])
        args.extend(["--bind" if mount["writable"] else "--ro-bind", source, target])

    args.extend(
        [
            "--chdir",
            cwd,
            "--setenv",
            "HOME",
            SANDBOX_HOME,
            "--setenv",
            "USER",
            "capybara",
            "--setenv",
            "LOGNAME",
            "capybara",
            "--setenv",
            "TMPDIR",
            "/tmp",
            "/bin/bash",
            "-lc",
        ]
    )
    return args


def handle_ping(_params: JsonDict) -> JsonDict:
    return {"ok": True}


def handle_create_session(params: JsonDict) -> JsonDict:
    session_id = params["session_id"]
    if not isinstance(session_id, str):
        raise ValueError("session_id is required")
    root = session_root(session_id)
    home = session_home(session_id)
    work = session_work(session_id)
    mounts = mounts_path(session_id)
    user = user_for_session(session_id)
    group = group_for_session(session_id)

    ensure_directory("/var/lib/capybara")
    chmod_chown("/var/lib/capybara", "root:root", "755")
    ensure_directory(STATE_ROOT)
    chmod_chown(STATE_ROOT, "root:root", "711")
    ensure_directory(root)
    ensure_directory(home)
    ensure_directory(work)
    ensure_file(mounts, "{}\n")

    run(["groupadd", "--force", group])
    if not user_exists(user):
        run(
            [
                "useradd",
                "--no-create-home",
                "--gid",
                group,
                "--home-dir",
                SANDBOX_HOME,
                "--shell",
                "/bin/bash",
                user,
            ]
        )
    else:
        run(["usermod", "--gid", group, "--home", SANDBOX_HOME, user])

    chmod_chown(root, f"root:{group}", "750")
    chmod_chown(home, f"{user}:{group}", "700")
    chmod_chown(work, f"{user}:{group}", "700")
    chmod_chown(mounts, "root:root", "600")
    return {"sessionRoot": root, "user": user}


def handle_connect_directory(params: JsonDict) -> JsonDict:
    session_id = params.get("session_id")
    host_path = params.get("host_path")
    mount_name = params.get("mount_name")
    writable = params.get("writable", False)
    replace = params.get("replace", False)
    if not isinstance(session_id, str):
        raise ValueError("session_id is required")
    if not isinstance(host_path, str):
        raise ValueError("host_path is required")
    if not isinstance(mount_name, str):
        raise ValueError("mount_name is required")
    if not isinstance(writable, bool):
        raise ValueError("writable must be a boolean")
    if not isinstance(replace, bool):
        raise ValueError("replace must be a boolean")
    validate_session_id(session_id)
    validate_mount_name(mount_name)
    if not os.path.isdir(session_root(session_id)):
        raise ValueError("session does not exist")

    source = resolve_host_path(host_path)
    mounts = load_mounts(session_id)
    if mount_name in mounts and not replace:
        raise ValueError("mount_name already connected")
    mounts[mount_name] = {"source": source, "writable": writable}
    store_mounts(session_id, mounts)
    return {"guestPath": f"/mnt/{mount_name}"}


def handle_delete_session(params: JsonDict) -> JsonDict:
    session_id = params.get("session_id")
    if not isinstance(session_id, str):
        raise ValueError("session_id is required")
    root = session_root(session_id)
    user = user_for_session(session_id)
    group = group_for_session(session_id)

    kill_session_processes(user)

    if user_exists(user):
        userdel = subprocess.run(["userdel", user], text=True, capture_output=True)
        if userdel.returncode != 0 and user_exists(user):
            raise RuntimeError(f"failed to delete session user {user}: {userdel.stderr.strip()}")

    if group_exists(group):
        groupdel = subprocess.run(["groupdel", group], text=True, capture_output=True)
        if groupdel.returncode != 0 and group_exists(group):
            raise RuntimeError(f"failed to delete session group {group}: {groupdel.stderr.strip()}")

    run(["rm", "-rf", root])
    return {"ok": True}


def handle_run_as_session(params: JsonDict) -> JsonDict:
    session_id = params.get("session_id")
    if not isinstance(session_id, str):
        raise ValueError("session_id is required")
    user = user_for_session(session_id)
    command = params.get("command")
    timeout_ms = parse_timeout_ms(params.get("timeout_ms", 60000))
    cwd = validate_sandbox_cwd(params.get("cwd"))

    if not isinstance(command, str):
        raise ValueError("command is required")
    if not os.path.isdir(session_root(session_id)):
        raise ValueError("session does not exist")

    proc = subprocess.Popen(
        ["sudo", "-u", user, "--", *bwrap_args(session_id, cwd), command],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )

    timed_out = False
    try:
        stdout, stderr = proc.communicate(timeout=timeout_ms / 1000)
    except subprocess.TimeoutExpired:
        timed_out = True
        stdout, stderr = terminate_session_command(proc, user)
    except Exception:
        terminate_session_command(proc, user)
        raise

    if timed_out:
        stderr = f"{stderr}\ncommand timed out".strip() + "\n"

    return {
        "exitCode": proc.returncode,
        "stdout": stdout,
        "stderr": stderr,
        "timedOut": timed_out,
    }


def handle_shutdown(_params: JsonDict) -> JsonDict:
    return {"ok": True, "shutdown": True}


METHODS: dict[str, Callable[[JsonDict], JsonDict]] = {
    "ping": handle_ping,
    "create_session": handle_create_session,
    "connect_directory": handle_connect_directory,
    "delete_session": handle_delete_session,
    "run_as_session": handle_run_as_session,
    "shutdown": handle_shutdown,
}


def write_response(response: JsonDict) -> None:
    print(json.dumps(response, separators=(",", ":")), flush=True)


def main() -> None:
    log("started")
    for line in sys.stdin:
        if not line.strip():
            continue

        request_id = None
        should_shutdown = False
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("request must be an object")
            request = cast(JsonDict, request)
            request_id = request.get("id")
            method = request.get("method")
            params_value = request.get("params")
            if params_value is None:
                params: JsonDict = {}
            elif isinstance(params_value, dict):
                params = cast(JsonDict, params_value)
            else:
                raise ValueError("params must be an object")
            if method not in METHODS:
                raise ValueError(f"unknown method: {method}")

            result = METHODS[method](params)
            should_shutdown = bool(result.pop("shutdown", False))
            write_response({"id": request_id, "result": result})
        except Exception as exc:
            log("request failed:", exc)
            write_response({"id": request_id, "error": {"message": str(exc)}})

        if should_shutdown:
            break

    log("stopped")


if __name__ == "__main__":
    main()
