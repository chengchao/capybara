# Supervisor Protocol

The VM supervisor is a newline-delimited JSON RPC process. The host starts it
inside the Lima VM and talks over stdin/stdout:

```text
host Rust process -> sudo python3 /opt/capybara/supervisor.py
request JSON line -> supervisor stdin
response JSON line <- supervisor stdout
logs <- supervisor stderr
```

Stdout is reserved for protocol responses. Logs must go to stderr.

## Response Shape

Success:

```json
{"id":"1","result":{}}
```

Failure:

```json
{"id":"1","error":{"message":"invalid session_id"}}
```

The response `id` must match the request `id`. Requests are handled
sequentially by one supervisor process.

## Methods

### ping

Request:

```json
{"id":"1","method":"ping","params":{}}
```

Response:

```json
{"id":"1","result":{"ok":true}}
```

### create_session

Creates or repairs the per-session Linux user, group, and state directory. This
operation is idempotent for the same `session_id`.

Request:

```json
{"id":"1","method":"create_session","params":{"session_id":"downloadsprobe"}}
```

Response:

```json
{
  "id": "1",
  "result": {
    "sessionRoot": "/var/lib/capybara/sessions/downloadsprobe",
    "user": "capybara_downloadsprobe"
  }
}
```

Session ids must match:

```text
^[a-z][a-z0-9_-]{0,22}$
```

### connect_directory

Stores an approved host directory mount in the session's root-owned
`mounts.json`. The actual bind happens per command through `bwrap`, not as a
persistent VM mount.

Request:

```json
{
  "id": "1",
  "method": "connect_directory",
  "params": {
    "session_id": "downloadsprobe",
    "host_path": "/host-home/Downloads",
    "mount_name": "Downloads",
    "writable": true,
    "replace": true
  }
}
```

Response:

```json
{"id":"1","result":{"guestPath":"/mnt/Downloads"}}
```

`host_path` must resolve under `/host-home` and must be an existing directory.
`mount_name` must match:

```text
^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$
```

### run_as_session

Runs a shell command as the per-session user inside a bwrap sandbox.

Request:

```json
{
  "id": "1",
  "method": "run_as_session",
  "params": {
    "session_id": "downloadsprobe",
    "cwd": "/workspace",
    "command": "pwd && ls -ld /mnt/Downloads",
    "timeout_ms": 60000
  }
}
```

Response:

```json
{
  "id": "1",
  "result": {
    "exitCode": 0,
    "stdout": "/workspace\n",
    "stderr": "",
    "timedOut": false
  }
}
```

Valid `cwd` roots are:

```text
/workspace
/home/capybara
/tmp
/mnt
```

The host-side Rust client waits `timeout_ms + 5s` for this method so the
supervisor can return its own timeout result.

### delete_session

Kills remaining session-owned processes, removes the session user/group, and
deletes the session state directory.

Request:

```json
{"id":"1","method":"delete_session","params":{"session_id":"downloadsprobe"}}
```

Response:

```json
{"id":"1","result":{"ok":true}}
```

### shutdown

Asks the supervisor process to exit after returning the response.

Request:

```json
{"id":"1","method":"shutdown","params":{}}
```

Response:

```json
{"id":"1","result":{"ok":true,"shutdown":true}}
```

## Sandbox Contract

Commands see:

```text
/home/capybara
/workspace
/tmp
/mnt/<approved-directory>
```

Commands must not see:

```text
/host-home
/var/lib/capybara
/root
/sessions
```

Capybara controls the Lima image and currently assumes Ubuntu's
systemd-resolved layout for DNS: `/etc/resolv.conf` points under
`/run/systemd/resolve`.
