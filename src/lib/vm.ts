import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

const VM_STATUS_EVENT = "vm-status";

export type VmStatus =
  | { kind: "starting" }
  | { kind: "running" }
  | { kind: "failed"; reason: string };

export function getVmStatus(): Promise<VmStatus> {
  return invoke<VmStatus>("get_vm_status");
}

export function subscribeVmStatus(
  cb: (status: VmStatus) => void,
): Promise<UnlistenFn> {
  return listen<VmStatus>(VM_STATUS_EVENT, (e) => cb(e.payload));
}
