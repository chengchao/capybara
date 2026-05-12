import "./host";

export type CreateSessionResult = {
  sessionRoot: string;
  user: string;
};

export type ConnectDirectoryResult = {
  guestPath: string;
};

export type DeleteSessionResult = {
  ok: boolean;
};

export function createSession(
  sessionId: string,
): Promise<CreateSessionResult> {
  return window.capybara.createSession(sessionId);
}

export function connectDirectory(args: {
  sessionId: string;
  hostPath: string;
  mountName: string;
  writable: boolean;
  replace: boolean;
}): Promise<ConnectDirectoryResult> {
  return window.capybara.connectDirectory(args);
}

export function deleteSession(
  sessionId: string,
): Promise<DeleteSessionResult> {
  return window.capybara.deleteSession(sessionId);
}
