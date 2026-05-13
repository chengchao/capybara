import type { VmStatus } from "./host";

export type { VmStatus };

export function getVmStatus(): Promise<VmStatus> {
  return window.capybara.getVmStatus();
}

export function subscribeVmStatus(
  cb: (status: VmStatus) => void,
): () => void {
  return window.capybara.onVmStatus(cb);
}
