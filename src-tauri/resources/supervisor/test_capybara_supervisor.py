import json
import os
import subprocess
import sys
import time
import importlib.util
from pathlib import Path


SCRIPT = Path(__file__).with_name("capybara_supervisor.py")
_SUPERVISOR_SPEC = importlib.util.spec_from_file_location("capybara_supervisor", SCRIPT)
assert _SUPERVISOR_SPEC is not None
capybara_supervisor = importlib.util.module_from_spec(_SUPERVISOR_SPEC)
assert _SUPERVISOR_SPEC.loader is not None
_SUPERVISOR_SPEC.loader.exec_module(capybara_supervisor)


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


def integration_enabled():
    return os.environ.get("CAPYBARA_SUPERVISOR_INTEGRATION") == "1"


def cleanup_session(proc, session_id):
    if proc.poll() is None:
        try:
            send_request(proc, "delete_session", {"session_id": session_id}, request_id=f"cleanup-{session_id}")
        except Exception:
            pass


def user_exists(user):
    return subprocess.run(["id", "-u", user], capture_output=True).returncode == 0


def group_exists(group):
    return subprocess.run(["getent", "group", group], capture_output=True).returncode == 0


def stat_owner_mode(path):
    st = os.stat(path)
    return st.st_uid, st.st_gid, st.st_mode & 0o7777


def uid_for_user(user):
    return int(subprocess.check_output(["id", "-u", user], text=True).strip())


def gid_for_group(group):
    return int(subprocess.check_output(["getent", "group", group], text=True).split(":")[2])


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


def test_bwrap_args_preserve_network_namespace():
    original_load_mounts = capybara_supervisor.load_mounts
    capybara_supervisor.load_mounts = lambda _session_id: {}
    try:
        args = capybara_supervisor.bwrap_args("args", "/workspace")
    finally:
        capybara_supervisor.load_mounts = original_load_mounts
    assert "--new-session" in args
    assert "--die-with-parent" in args
    assert "--unshare-pid" in args
    assert "--proc" in args
    assert "--unshare-all" not in args
    assert "--unshare-net" not in args
    assert "--ro-bind-try" in args
    assert "/run/systemd/resolve" in args


def test_session_layout_and_mounts_json():
    if not integration_enabled():
        return

    proc = start_supervisor()
    try:
        created = send_request(proc, "create_session", {"session_id": "layout"}, request_id="create")
        assert created == {
            "id": "create",
            "result": {
                "sessionRoot": "/var/lib/capybara/sessions/layout",
                "user": "capybara_layout",
            },
        }
        uid = uid_for_user("capybara_layout")
        gid = gid_for_group("capybara_layout")

        root_uid, root_gid, root_mode = stat_owner_mode("/var/lib/capybara/sessions/layout")
        home_uid, home_gid, home_mode = stat_owner_mode("/var/lib/capybara/sessions/layout/home")
        work_uid, work_gid, work_mode = stat_owner_mode("/var/lib/capybara/sessions/layout/work")
        mounts_uid, mounts_gid, mounts_mode = stat_owner_mode("/var/lib/capybara/sessions/layout/mounts.json")

        assert root_uid == 0
        assert root_gid == gid
        assert root_mode == 0o750
        assert home_uid == uid
        assert home_gid == gid
        assert home_mode == 0o700
        assert work_uid == uid
        assert work_gid == gid
        assert work_mode == 0o700
        assert mounts_uid == 0
        assert mounts_gid == 0
        assert mounts_mode == 0o600
        assert json.loads(Path("/var/lib/capybara/sessions/layout/mounts.json").read_text()) == {}
    finally:
        cleanup_session(proc, "layout")
        shutdown(proc)


def test_create_session_is_idempotent():
    if not integration_enabled():
        return

    proc = start_supervisor()
    try:
        first = send_request(proc, "create_session", {"session_id": "idem"}, request_id="first")
        second = send_request(proc, "create_session", {"session_id": "idem"}, request_id="second")

        expected = {
            "sessionRoot": "/var/lib/capybara/sessions/idem",
            "user": "capybara_idem",
        }
        assert first == {"id": "first", "result": expected}
        assert second == {"id": "second", "result": expected}
        assert user_exists("capybara_idem")
        assert group_exists("capybara_idem")
        assert Path("/var/lib/capybara/sessions/idem/mounts.json").exists()
    finally:
        cleanup_session(proc, "idem")
        shutdown(proc)


def test_bwrap_session_can_use_home_workspace_and_tmp():
    if not integration_enabled():
        return

    proc = start_supervisor()
    try:
        send_request(proc, "create_session", {"session_id": "basic"}, request_id="create")
        ran = send_request(
            proc,
            "run_as_session",
            {
                "session_id": "basic",
                "command": "id -un && pwd && test \"$HOME\" = /home/capybara && touch /home/capybara/home-file /workspace/work-file /tmp/tmp-file",
                "timeout_ms": 5000,
            },
            request_id="run",
        )
        assert ran["id"] == "run"
        assert ran["result"]["exitCode"] == 0, ran
        assert "capybara_basic" in ran["result"]["stdout"]
        assert "/workspace" in ran["result"]["stdout"]
        assert Path("/var/lib/capybara/sessions/basic/home/home-file").exists()
        assert Path("/var/lib/capybara/sessions/basic/work/work-file").exists()
    finally:
        cleanup_session(proc, "basic")
        shutdown(proc)


def test_bwrap_hides_host_and_supervisor_paths():
    if not integration_enabled():
        return

    proc = start_supervisor()
    try:
        send_request(proc, "create_session", {"session_id": "hidden"}, request_id="create")
        ran = send_request(
            proc,
            "run_as_session",
            {
                "session_id": "hidden",
                "command": "test ! -e /host-home && test ! -e /var/lib/capybara && test ! -e /sessions && test ! -e /root",
                "timeout_ms": 5000,
            },
            request_id="hidden",
        )
        assert ran["result"]["exitCode"] == 0, ran
    finally:
        cleanup_session(proc, "hidden")
        shutdown(proc)


def test_cwd_must_be_inside_sandbox_roots():
    if not integration_enabled():
        return

    proc = start_supervisor()
    try:
        send_request(proc, "create_session", {"session_id": "badcwd"}, request_id="create")
        response = send_request(
            proc,
            "run_as_session",
            {
                "session_id": "badcwd",
                "cwd": "/etc",
                "command": "pwd",
                "timeout_ms": 5000,
            },
            request_id="badcwd",
        )
        assert response["id"] == "badcwd"
        assert response["error"]["message"] == "cwd outside sandbox writable roots"
    finally:
        cleanup_session(proc, "badcwd")
        shutdown(proc)


def test_connect_directory_validates_and_writes_mounts_json():
    if not integration_enabled():
        return

    src = Path("/host-home/Desktop")
    subprocess.run(["mkdir", "-p", str(src)], check=True)
    proc = start_supervisor()
    try:
        send_request(proc, "create_session", {"session_id": "connect"}, request_id="create")
        bad_name = send_request(
            proc,
            "connect_directory",
            {
                "session_id": "connect",
                "host_path": str(src),
                "mount_name": "../Desktop",
                "writable": True,
            },
            request_id="bad-name",
        )
        assert bad_name["error"]["message"] == "invalid mount_name"

        outside = send_request(
            proc,
            "connect_directory",
            {
                "session_id": "connect",
                "host_path": "/tmp",
                "mount_name": "Tmp",
                "writable": True,
            },
            request_id="outside",
        )
        assert outside["error"]["message"] == "host_path outside host root"

        connected = send_request(
            proc,
            "connect_directory",
            {
                "session_id": "connect",
                "host_path": str(src),
                "mount_name": "Desktop",
                "writable": True,
            },
            request_id="connect",
        )
        assert connected == {"id": "connect", "result": {"guestPath": "/mnt/Desktop"}}
        mounts = json.loads(Path("/var/lib/capybara/sessions/connect/mounts.json").read_text())
        assert mounts == {"Desktop": {"source": "/host-home/Desktop", "writable": True}}

        duplicate = send_request(
            proc,
            "connect_directory",
            {
                "session_id": "connect",
                "host_path": str(src),
                "mount_name": "Desktop",
                "writable": True,
            },
            request_id="duplicate",
        )
        assert duplicate["error"]["message"] == "mount_name already connected"
    finally:
        cleanup_session(proc, "connect")
        shutdown(proc)
        subprocess.run(["rm", "-rf", "/host-home/Desktop"], check=False)


def test_connected_directory_is_visible_and_writable():
    if not integration_enabled():
        return

    src = Path("/host-home/Writable")
    subprocess.run(["mkdir", "-p", str(src)], check=True)
    proc = start_supervisor()
    try:
        send_request(proc, "create_session", {"session_id": "rw"}, request_id="create")
        subprocess.run(["chown", "capybara_rw:capybara_rw", str(src)], check=True)
        send_request(
            proc,
            "connect_directory",
            {"session_id": "rw", "host_path": str(src), "mount_name": "Writable", "writable": True},
            request_id="connect",
        )
        ran = send_request(
            proc,
            "run_as_session",
            {
                "session_id": "rw",
                "command": "echo ok > /mnt/Writable/from-sandbox && cat /mnt/Writable/from-sandbox",
                "timeout_ms": 5000,
            },
            request_id="run",
        )
        assert ran["result"]["exitCode"] == 0, ran
        assert ran["result"]["stdout"].strip() == "ok"
        assert Path("/host-home/Writable/from-sandbox").read_text().strip() == "ok"
    finally:
        cleanup_session(proc, "rw")
        shutdown(proc)
        subprocess.run(["rm", "-rf", "/host-home/Writable"], check=False)


def test_readonly_connected_directory_blocks_writes():
    if not integration_enabled():
        return

    src = Path("/host-home/Readonly")
    subprocess.run(["mkdir", "-p", str(src)], check=True)
    Path(src, "file").write_text("readable\n")
    proc = start_supervisor()
    try:
        send_request(proc, "create_session", {"session_id": "ro"}, request_id="create")
        send_request(
            proc,
            "connect_directory",
            {"session_id": "ro", "host_path": str(src), "mount_name": "Readonly", "writable": False},
            request_id="connect",
        )
        ran = send_request(
            proc,
            "run_as_session",
            {
                "session_id": "ro",
                "command": "cat /mnt/Readonly/file && touch /mnt/Readonly/nope",
                "timeout_ms": 5000,
            },
            request_id="run",
        )
        assert ran["result"]["exitCode"] != 0
        assert "readable" in ran["result"]["stdout"]
        assert "Read-only file system" in ran["result"]["stderr"] or "Permission denied" in ran["result"]["stderr"]
        assert not Path(src, "nope").exists()
    finally:
        cleanup_session(proc, "ro")
        shutdown(proc)
        subprocess.run(["rm", "-rf", "/host-home/Readonly"], check=False)


def test_connected_directory_revalidated_before_bwrap_bind():
    if not integration_enabled():
        return

    approved = Path("/host-home/Approved")
    outside = Path("/tmp/capybara-outside")
    subprocess.run(["rm", "-rf", str(approved), str(outside)], check=False)
    subprocess.run(["mkdir", "-p", str(approved), str(outside)], check=True)
    Path(outside, "secret").write_text("outside\n")

    proc = start_supervisor()
    try:
        send_request(proc, "create_session", {"session_id": "symlink"}, request_id="create")
        connected = send_request(
            proc,
            "connect_directory",
            {"session_id": "symlink", "host_path": str(approved), "mount_name": "Approved", "writable": True},
            request_id="connect",
        )
        assert connected == {"id": "connect", "result": {"guestPath": "/mnt/Approved"}}

        subprocess.run(["rm", "-rf", str(approved)], check=True)
        os.symlink(str(outside), str(approved))

        ran = send_request(
            proc,
            "run_as_session",
            {
                "session_id": "symlink",
                "command": "cat /mnt/Approved/secret",
                "timeout_ms": 5000,
            },
            request_id="run",
        )
        assert ran["id"] == "run"
        assert ran["error"]["message"] == "host_path outside host root"
    finally:
        cleanup_session(proc, "symlink")
        shutdown(proc)
        subprocess.run(["rm", "-rf", str(approved), str(outside)], check=False)


def test_timeout_kills_bwrap_process_tree():
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
                "command": "setsid sh -c 'trap \"\" TERM; while true; do sleep 600; done' >/dev/null 2>&1 & wait",
                "timeout_ms": 100,
            },
            request_id="timeout",
        )
        assert timed_out["result"]["timedOut"] is True
        assert "command timed out" in timed_out["result"]["stderr"]
        assert not has_process_for_user_containing("capybara_timeout", "sleep 600")
    finally:
        cleanup_session(proc, "timeout")
        shutdown(proc)


def test_timeout_response_shape_is_stable():
    if not integration_enabled():
        return

    proc = start_supervisor()
    try:
        send_request(proc, "create_session", {"session_id": "timeoutshape"}, request_id="create")
        timed_out = send_request(
            proc,
            "run_as_session",
            {
                "session_id": "timeoutshape",
                "command": "sleep 5",
                "timeout_ms": 100,
            },
            request_id="timeout",
        )
        assert timed_out["id"] == "timeout"
        result = timed_out["result"]
        assert set(result) == {"exitCode", "stdout", "stderr", "timedOut"}
        assert isinstance(result["exitCode"], int)
        assert isinstance(result["stdout"], str)
        assert isinstance(result["stderr"], str)
        assert result["timedOut"] is True
        assert "command timed out" in result["stderr"]
    finally:
        cleanup_session(proc, "timeoutshape")
        shutdown(proc)


def test_delete_session_removes_user_group_and_state():
    if not integration_enabled():
        return

    proc = start_supervisor()
    try:
        send_request(proc, "create_session", {"session_id": "delete"}, request_id="create")
        deleted = send_request(proc, "delete_session", {"session_id": "delete"}, request_id="delete")
        assert deleted == {"id": "delete", "result": {"ok": True}}
        assert not Path("/var/lib/capybara/sessions/delete").exists()
        assert not user_exists("capybara_delete")
        assert not group_exists("capybara_delete")
    finally:
        cleanup_session(proc, "delete")
        shutdown(proc)


def test_startup_sweep_kills_orphan_session_processes():
    if not integration_enabled():
        return

    user = "capybara_orphan"
    subprocess.run(["userdel", "-f", user], capture_output=True)
    subprocess.run(["useradd", "-M", user], check=True)
    try:
        orphan = subprocess.Popen(
            ["sleep", "999"],
            user=user,
            start_new_session=True,
        )
        try:
            for _ in range(40):
                if has_process_for_user_containing(user, "sleep"):
                    break
                time.sleep(0.05)
            assert has_process_for_user_containing(user, "sleep")

            capybara_supervisor.kill_stale_session_processes()

            returncode = orphan.wait(timeout=2)
            assert returncode != 0, "orphan should have exited via signal"
            assert user_exists(user), "sweep must not remove the session user"
        finally:
            if orphan.poll() is None:
                orphan.kill()
                orphan.wait()
    finally:
        subprocess.run(["userdel", "-f", user], capture_output=True)
