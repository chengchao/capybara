import { invoke } from "@tauri-apps/api/core";

export type CreateSessionResult = {
  sessionRoot: string;
  user: string;
};

export type ConnectDirectoryResult = {
  guestPath: string;
};

export type RunSessionResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type DeleteSessionResult = {
  ok: boolean;
};

export function createSession(
  sessionId: string,
): Promise<CreateSessionResult> {
  return invoke<CreateSessionResult>("create_session", { sessionId });
}

export function connectDirectory(args: {
  sessionId: string;
  hostPath: string;
  mountName: string;
  writable: boolean;
  replace: boolean;
}): Promise<ConnectDirectoryResult> {
  return invoke<ConnectDirectoryResult>("connect_directory", args);
}

export function runAsSession(args: {
  sessionId: string;
  command: string;
  cwd?: string;
  timeoutMs?: number;
}): Promise<RunSessionResult> {
  return invoke<RunSessionResult>("run_as_session", args);
}

export function deleteSession(
  sessionId: string,
): Promise<DeleteSessionResult> {
  return invoke<DeleteSessionResult>("delete_session", { sessionId });
}
