import json
import os
import subprocess
import sys
import time
from pathlib import Path


SCRIPT = Path(__file__).with_name("capybara_supervisor.py")


def start_supervisor():
    return subprocess.Popen(
        [sys.executable, str(SCRIPT)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def send_request(proc, method, params=None, request_id="1"):
    proc.stdin.write(
        json.dumps(
            {
                "id": request_id,
                "method": method,
                "params": params or {},
            }
        )
        + "\n"
    )
    proc.stdin.flush()
    return json.loads(proc.stdout.readline())


def shutdown(proc):
    if proc.poll() is None:
        send_request(proc, "shutdown", request_id="shutdown")
        proc.wait(timeout=2)


def test_ping_uses_stdout_json_and_stderr_logs():
    proc = start_supervisor()
    try:
        response = send_request(proc, "ping")
        assert response == {"id": "1", "result": {"ok": True}}
        shutdown(proc)
        stderr = proc.stderr.read()
        assert "supervisor: started" in stderr
        assert "supervisor: stopped" in stderr
    finally:
        if proc.poll() is None:
            proc.kill()


def test_unknown_method_returns_structured_error():
    proc = start_supervisor()
    try:
        response = send_request(proc, "missing_method")
        assert response["id"] == "1"
        assert "unknown method" in response["error"]["message"]
    finally:
        shutdown(proc)


def test_malformed_json_returns_error_without_exiting():
    proc = start_supervisor()
    try:
        proc.stdin.write("not-json\n")
        proc.stdin.flush()
        response = json.loads(proc.stdout.readline())
        assert response["id"] is None
        assert "Expecting value" in response["error"]["message"]

        assert send_request(proc, "ping", request_id="2") == {
            "id": "2",
            "result": {"ok": True},
        }
    finally:
        shutdown(proc)


def test_invalid_session_id_is_rejected_before_sudo():
    proc = start_supervisor()
    try:
        for index, session_id in enumerate(["../escape", "Foo", "1foo"], start=1):
            response = send_request(
                proc,
                "create_session",
                {"session_id": session_id},
                request_id=str(index),
            )
            assert response["id"] == str(index)
            assert response["error"]["message"] == "invalid session_id"
    finally:
        shutdown(proc)


def integration_enabled():
    return os.environ.get("CAPYBARA_SUPERVISOR_INTEGRATION") == "1"


def has_process_for_user_containing(user, needle):
    try:
        uid = subprocess.check_output(["id", "-u", user], text=True).strip()
    except subprocess.CalledProcessError:
        return False
    for status_path in Path("/proc").glob("[0-9]*/status"):
        try:
            status = status_path.read_text()
            cmdline = status_path.with_name("cmdline").read_text().replace("\x00", " ")
        except OSError:
            continue
        if f"Uid:\t{uid}\t" in status and needle in cmdline:
            return True
    return False


def test_session_lifecycle_and_cwd_containment():
    if not integration_enabled():
        return

    proc = start_supervisor()
    try:
        created = send_request(
            proc,
            "create_session",
            {"session_id": "itest_ok-1"},
            request_id="create",
        )
        assert created == {
            "id": "create",
            "result": {
                "sessionRoot": "/sessions/itest_ok-1",
                "user": "capybara_itest_ok-1",
            },
        }

        ran = send_request(
            proc,
            "run_as_session",
            {
                "session_id": "itest_ok-1",
                "cwd": "/sessions/itest_ok-1/work",
                "command": "id -un && pwd && touch owned-file && test -f owned-file",
                "timeout_ms": 5000,
            },
            request_id="run",
        )
        assert ran["id"] == "run"
        assert ran["result"]["exitCode"] == 0
        assert "capybara_itest_ok-1" in ran["result"]["stdout"]
        assert "/sessions/itest_ok-1/work" in ran["result"]["stdout"]
        assert ran["result"]["timedOut"] is False

        escaped = send_request(
            proc,
            "run_as_session",
            {
                "session_id": "itest_ok-1",
                "cwd": "/tmp",
                "command": "pwd",
                "timeout_ms": 5000,
            },
            request_id="escape",
        )
        assert escaped["id"] == "escape"
        assert escaped["error"]["message"] == "cwd outside session root"

        deleted = send_request(
            proc,
            "delete_session",
            {"session_id": "itest_ok-1"},
            request_id="delete",
        )
        assert deleted == {"id": "delete", "result": {"ok": True}}
        assert not Path("/sessions/itest_ok-1").exists()
        assert subprocess.run(["id", "-u", "capybara_itest_ok-1"], capture_output=True).returncode != 0
    finally:
        if proc.poll() is None:
            try:
                send_request(proc, "delete_session", {"session_id": "itest_ok-1"}, request_id="cleanup")
            except Exception:
                pass
            shutdown(proc)


def test_timed_out_command_kills_process_group():
    if not integration_enabled():
        return

    proc = start_supervisor()
    try:
        send_request(proc, "create_session", {"session_id": "timeout"}, request_id="create")
        timed_out = send_request(
            proc,
            "run_as_session",
            {
                "session_id": "timeout",
                "cwd": "/sessions/timeout/work",
                "command": "sleep 600",
                "timeout_ms": 100,
            },
            request_id="timeout",
        )
        assert timed_out["result"]["timedOut"] is True
        assert timed_out["result"]["exitCode"] != 0
        assert "command timed out" in timed_out["result"]["stderr"]

        assert not has_process_for_user_containing("capybara_timeout", "sleep 600")
    finally:
        if proc.poll() is None:
            try:
                send_request(proc, "delete_session", {"session_id": "timeout"}, request_id="cleanup")
            except Exception:
                pass
            shutdown(proc)


def test_timed_out_command_kills_detached_session_user_processes():
    if not integration_enabled():
        return

    proc = start_supervisor()
    try:
        send_request(proc, "create_session", {"session_id": "detached"}, request_id="create")
        timed_out = send_request(
            proc,
            "run_as_session",
            {
                "session_id": "detached",
                "cwd": "/sessions/detached/work",
                "command": "setsid sh -c 'trap \"\" TERM; while true; do sleep 600; done' >/dev/null 2>&1 & wait",
                "timeout_ms": 100,
            },
            request_id="timeout",
        )
        assert timed_out["result"]["timedOut"] is True
        assert "command timed out" in timed_out["result"]["stderr"]
        assert not has_process_for_user_containing("capybara_detached", "sleep 600")
    finally:
        if proc.poll() is None:
            try:
                send_request(proc, "delete_session", {"session_id": "detached"}, request_id="cleanup")
            except Exception:
                pass
            shutdown(proc)


def test_negative_timeout_is_rejected_before_spawn():
    if not integration_enabled():
        return

    proc = start_supervisor()
    try:
        send_request(proc, "create_session", {"session_id": "badtimeout"}, request_id="create")
        response = send_request(
            proc,
            "run_as_session",
            {
                "session_id": "badtimeout",
                "cwd": "/sessions/badtimeout/work",
                "command": "sleep 600",
                "timeout_ms": -1,
            },
            request_id="bad-timeout",
        )
        assert response["id"] == "bad-timeout"
        assert response["error"]["message"] == "timeout_ms must be positive"
        assert not has_process_for_user_containing("capybara_badtimeout", "sleep 600")
    finally:
        if proc.poll() is None:
            try:
                send_request(proc, "delete_session", {"session_id": "badtimeout"}, request_id="cleanup")
            except Exception:
                pass
            shutdown(proc)


def test_delete_session_removes_user_with_live_process():
    if not integration_enabled():
        return

    proc = start_supervisor()
    try:
        send_request(proc, "create_session", {"session_id": "liveproc"}, request_id="create")
        started = send_request(
            proc,
            "run_as_session",
            {
                "session_id": "liveproc",
                "cwd": "/sessions/liveproc/work",
                "command": "setsid sleep 600 >/dev/null 2>&1 &",
                "timeout_ms": 5000,
            },
            request_id="start-bg",
        )
        assert started["result"]["exitCode"] == 0
        assert has_process_for_user_containing("capybara_liveproc", "sleep 600")

        deleted = send_request(
            proc,
            "delete_session",
            {"session_id": "liveproc"},
            request_id="delete",
        )
        assert deleted == {"id": "delete", "result": {"ok": True}}
        assert not Path("/sessions/liveproc").exists()
        assert subprocess.run(["id", "-u", "capybara_liveproc"], capture_output=True).returncode != 0
        assert not has_process_for_user_containing("capybara_liveproc", "sleep 600")
    finally:
        if proc.poll() is None:
            try:
                send_request(proc, "delete_session", {"session_id": "liveproc"}, request_id="cleanup")
            except Exception:
                pass
            shutdown(proc)


def _stat_owner_mode(path):
    st = os.stat(path)
    return st.st_uid, st.st_gid, st.st_mode & 0o7777


def test_create_session_leaves_mnt_root_owned():
    if not integration_enabled():
        return

    proc = start_supervisor()
    try:
        send_request(
            proc,
            "create_session",
            {"session_id": "owners"},
            request_id="create",
        )
        user_uid = int(subprocess.check_output(["id", "-u", "capybara_owners"], text=True).strip())

        home_uid, _, _ = _stat_owner_mode("/sessions/owners/home")
        work_uid, _, _ = _stat_owner_mode("/sessions/owners/work")
        mnt_uid, mnt_gid, mnt_mode = _stat_owner_mode("/sessions/owners/mnt")

        assert home_uid == user_uid, f"home/ should be owned by session user, got uid {home_uid}"
        assert work_uid == user_uid, f"work/ should be owned by session user, got uid {work_uid}"
        assert mnt_uid == 0, f"mnt/ should be root-owned, got uid {mnt_uid}"
        assert mnt_gid == 0, f"mnt/ should be root-grouped, got gid {mnt_gid}"
        assert mnt_mode == 0o755, f"mnt/ should be 0755, got {oct(mnt_mode)}"
    finally:
        if proc.poll() is None:
            try:
                send_request(proc, "delete_session", {"session_id": "owners"}, request_id="cleanup")
            except Exception:
                pass
            shutdown(proc)


def test_session_user_cannot_create_entries_in_mnt():
    if not integration_enabled():
        return

    proc = start_supervisor()
    try:
        send_request(
            proc,
            "create_session",
            {"session_id": "nowrite"},
            request_id="create",
        )

        listed = send_request(
            proc,
            "run_as_session",
            {
                "session_id": "nowrite",
                "cwd": "/sessions/nowrite/work",
                "command": "ls /sessions/nowrite/mnt",
                "timeout_ms": 5000,
            },
            request_id="ls",
        )
        assert listed["result"]["exitCode"] == 0

        wrote = send_request(
            proc,
            "run_as_session",
            {
                "session_id": "nowrite",
                "cwd": "/sessions/nowrite/work",
                "command": "touch /sessions/nowrite/mnt/foo",
                "timeout_ms": 5000,
            },
            request_id="touch",
        )
        assert wrote["result"]["exitCode"] != 0
        assert "Permission denied" in wrote["result"]["stderr"]

        linked = send_request(
            proc,
            "run_as_session",
            {
                "session_id": "nowrite",
                "cwd": "/sessions/nowrite/work",
                "command": "ln -s /etc /sessions/nowrite/mnt/Hijack",
                "timeout_ms": 5000,
            },
            request_id="ln",
        )
        assert linked["result"]["exitCode"] != 0
        assert "Permission denied" in linked["result"]["stderr"]

        ok = send_request(
            proc,
            "run_as_session",
            {
                "session_id": "nowrite",
                "cwd": "/sessions/nowrite/work",
                "command": "touch /sessions/nowrite/work/agent-owned",
                "timeout_ms": 5000,
            },
            request_id="work-write",
        )
        assert ok["result"]["exitCode"] == 0
    finally:
        if proc.poll() is None:
            try:
                send_request(proc, "delete_session", {"session_id": "nowrite"}, request_id="cleanup")
            except Exception:
                pass
            shutdown(proc)


_BIND_MOUNT_SUPPORTED: bool | None = None


def _can_bind_mount():
    global _BIND_MOUNT_SUPPORTED
    if _BIND_MOUNT_SUPPORTED is not None:
        return _BIND_MOUNT_SUPPORTED
    src = "/tmp/_capybara_bind_probe_src"
    tgt = "/tmp/_capybara_bind_probe_tgt"
    subprocess.run(["mkdir", "-p", src, tgt], check=True)
    try:
        probe = subprocess.run(
            ["mount", "--bind", src, tgt], text=True, capture_output=True
        )
        if probe.returncode != 0:
            _BIND_MOUNT_SUPPORTED = False
            return False
        subprocess.run(["umount", tgt], check=False)
        _BIND_MOUNT_SUPPORTED = True
        return True
    finally:
        subprocess.run(["rm", "-rf", src, tgt], check=False)


def _wait_for_cwd(pid, target, timeout=2.0):
    deadline = time.monotonic() + timeout
    target_real = os.path.realpath(target)
    while time.monotonic() < deadline:
        try:
            actual = os.readlink(f"/proc/{pid}/cwd")
        except OSError:
            actual = ""
        if actual == target_real:
            return True
        time.sleep(0.01)
    return False


def _bind_into_session(session_id, mnt_name, src_dir):
    target = f"/sessions/{session_id}/mnt/{mnt_name}"
    subprocess.run(["mkdir", "-p", target], check=True)
    subprocess.run(["mount", "--bind", src_dir, target], check=True)
    return target


def test_delete_session_unmounts_bind_before_rm():
    if not integration_enabled():
        return
    if not _can_bind_mount():
        # Container lacks CAP_SYS_ADMIN; this safety test cannot run here.
        # Run with `docker run --cap-add=SYS_ADMIN` (already wired in
        # `bun run test:supervisor`) to exercise it.
        return

    src_dir = "/tmp/_capybara_bind_src"
    sentinel = os.path.join(src_dir, "host-file")
    subprocess.run(["mkdir", "-p", src_dir], check=True)
    Path(sentinel).write_text("from-host\n")

    proc = start_supervisor()
    try:
        send_request(
            proc,
            "create_session",
            {"session_id": "bindmnt"},
            request_id="create",
        )
        target = _bind_into_session("bindmnt", "data", src_dir)
        assert Path(target, "host-file").exists()

        deleted = send_request(
            proc,
            "delete_session",
            {"session_id": "bindmnt"},
            request_id="delete",
        )
        assert deleted == {"id": "delete", "result": {"ok": True}}
        assert not Path("/sessions/bindmnt").exists()
        with open("/proc/mounts") as f:
            assert target not in f.read()
        # rm -rf must NOT have followed the bind into the host source.
        assert Path(sentinel).exists()
        assert Path(sentinel).read_text() == "from-host\n"
    finally:
        # Force-clean if the success path didn't run (test failed or aborted).
        subprocess.run(
            ["umount", "/sessions/bindmnt/mnt/data"], check=False, capture_output=True
        )
        subprocess.run(["rm", "-rf", "/sessions/bindmnt"], check=False)
        subprocess.run(["rm", "-rf", src_dir], check=False)
        if proc.poll() is None:
            shutdown(proc)


def test_delete_session_raises_if_unmount_fails():
    if not integration_enabled():
        return
    if not _can_bind_mount():
        return

    src_dir = "/tmp/_capybara_busy_src"
    subprocess.run(["mkdir", "-p", src_dir], check=True)

    proc = start_supervisor()
    busy_proc = None
    try:
        send_request(
            proc,
            "create_session",
            {"session_id": "busymnt"},
            request_id="create",
        )
        target = _bind_into_session("busymnt", "busy", src_dir)

        # Hold the mount busy from outside the session so umount returns EBUSY,
        # exercising the "umount failed → don't fall through to rm -rf" branch.
        busy_proc = subprocess.Popen(
            ["sleep", "300"],
            cwd=target,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        assert _wait_for_cwd(busy_proc.pid, target), "busy_proc never entered the bind target"

        deleted = send_request(
            proc,
            "delete_session",
            {"session_id": "busymnt"},
            request_id="delete",
        )
        assert "error" in deleted, f"expected error, got {deleted}"
        assert "failed to unmount" in deleted["error"]["message"]
        # Session root must survive — rm -rf would have been a data-loss event.
        assert Path("/sessions/busymnt").exists()
    finally:
        if busy_proc is not None and busy_proc.poll() is None:
            busy_proc.kill()
            busy_proc.wait()
        subprocess.run(
            ["umount", "/sessions/busymnt/mnt/busy"],
            check=False,
            capture_output=True,
        )
        subprocess.run(["rm", "-rf", "/sessions/busymnt"], check=False)
        subprocess.run(["rm", "-rf", src_dir], check=False)
        if proc.poll() is None:
            shutdown(proc)
