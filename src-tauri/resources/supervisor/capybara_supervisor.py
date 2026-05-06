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
SESSIONS_ROOT = "/sessions"
JsonDict = Dict[str, Any]


def log(*parts: object) -> None:
    print("supervisor:", *parts, file=sys.stderr, flush=True)


def validate_session_id(session_id: str) -> None:
    if not SESSION_RE.fullmatch(session_id):
        raise ValueError("invalid session_id")


def user_for_session(session_id: str) -> str:
    validate_session_id(session_id)
    return f"capybara_{session_id}"


def group_for_session(session_id: str) -> str:
    validate_session_id(session_id)
    return f"capybara_{session_id}"


def session_root(session_id: str) -> str:
    validate_session_id(session_id)
    return os.path.join(SESSIONS_ROOT, session_id)


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


def kill_session_processes(user: str) -> None:
    signal_user_processes(user, signal.SIGTERM)
    if wait_user_processes_gone(user, 1):
        return

    signal_user_processes(user, signal.SIGKILL)
    if not wait_user_processes_gone(user, 1):
        raise RuntimeError(f"failed to kill session processes for {user}")


def terminate_session_command(proc: subprocess.Popen[str], user: str) -> tuple[str, str]:
    signal_process_group(proc, signal.SIGTERM)
    try:
        kill_session_processes(user)
    finally:
        signal_process_group(proc, signal.SIGKILL)
    return collect_process_output(proc)


_MOUNT_OCTAL_ESCAPE = re.compile(r"\\([0-7]{3})")


def decode_mount_field(value: str) -> str:
    """Decode kernel mangle_path escapes from /proc/mounts (e.g. ``\\040`` for space)."""
    return _MOUNT_OCTAL_ESCAPE.sub(lambda m: chr(int(m.group(1), 8)), value)


def handle_ping(_params: JsonDict) -> JsonDict:
    return {"ok": True}


def handle_create_session(params: JsonDict) -> JsonDict:
    session_id = params["session_id"]
    if not isinstance(session_id, str):
        raise ValueError("session_id is required")
    root = session_root(session_id)
    user = user_for_session(session_id)
    group = group_for_session(session_id)

    home = os.path.join(root, "home")
    work = os.path.join(root, "work")
    mnt = os.path.join(root, "mnt")
    ensure_directory(root)
    ensure_directory(home)
    ensure_directory(work)
    ensure_directory(mnt)

    run(["groupadd", "--force", group])

    if not user_exists(user):
        run(
            [
                "useradd",
                "--no-create-home",
                "--gid",
                group,
                "--home-dir",
                home,
                "--shell",
                "/bin/bash",
                user,
            ]
        )
    else:
        run(["usermod", "--gid", group, user])

    # The session root and mnt/ catalog stay root-owned so the agent cannot
    # remove mnt/ and replace it with a symlink before the supervisor binds
    # approved host directories into it. The per-session group lets only this
    # session traverse its root and mount catalog; other session users cannot.
    chmod_chown(root, f"root:{group}", "750")
    chmod_chown(home, f"{user}:{user}", "700")
    chmod_chown(work, f"{user}:{user}", "700")
    chmod_chown(mnt, f"root:{group}", "750")
    return {"sessionRoot": root, "user": user}


def unmount_session_mounts(root: str) -> None:
    # Unmount everything under <root>/mnt/ before the caller rm -rf's <root>.
    # Without this, rm -rf would recurse INTO each bind mount and delete the
    # host source files. /proc/mounts is in mount order, so we unmount in
    # reverse to handle nested mounts. A failed umount is fatal — letting
    # delete_session proceed would lose host data.
    mnt_root = Path(root) / "mnt"
    targets: list[str] = []
    try:
        with open("/proc/mounts") as f:
            for line in f:
                fields = line.split()
                if len(fields) < 2:
                    continue
                target = decode_mount_field(fields[1])
                if Path(target).is_relative_to(mnt_root):
                    targets.append(target)
    except OSError:
        return
    for target in sorted(targets, key=len, reverse=True):
        result = subprocess.run(["umount", "--", target], text=True, capture_output=True)
        if result.returncode != 0:
            raise RuntimeError(
                f"failed to unmount {target}: {result.stderr.strip() or 'unknown error'}"
            )


def handle_delete_session(params: JsonDict) -> JsonDict:
    session_id = params.get("session_id")
    if not isinstance(session_id, str):
        raise ValueError("session_id is required")
    root = session_root(session_id)
    user = user_for_session(session_id)
    group = group_for_session(session_id)

    kill_session_processes(user)
    unmount_session_mounts(root)

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
    root = os.path.realpath(session_root(session_id))
    user = user_for_session(session_id)
    cwd = params.get("cwd")
    command = params.get("command")
    timeout_ms = parse_timeout_ms(params.get("timeout_ms", 60000))

    if not isinstance(cwd, str) or not cwd:
        raise ValueError("cwd is required")
    if not isinstance(command, str):
        raise ValueError("command is required")
    cwd_real = os.path.realpath(cwd)
    if cwd_real != root and not cwd_real.startswith(root + os.sep):
        raise ValueError("cwd outside session root")

    proc = subprocess.Popen(
        ["sudo", "-u", user, "--", "bash", "-lc", command],
        cwd=cwd_real,
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
