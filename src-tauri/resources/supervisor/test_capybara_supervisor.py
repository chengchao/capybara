import json
import os
import subprocess
import sys
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
