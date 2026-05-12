import "./host";

export type VmStatus =
  | { kind: "starting" }
  | { kind: "running" }
  | { kind: "failed"; reason: string };

export function getVmStatus(): Promise<VmStatus> {
  return window.capybara.getVmStatus();
}

export function subscribeVmStatus(
  cb: (status: VmStatus) => void,
): () => void {
  return window.capybara.onVmStatus((status) => cb(status as VmStatus));
}
