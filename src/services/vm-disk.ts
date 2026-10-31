/**
 * Disk sizes LFG asks Mags for. The two hosts keep a 25 GB reserve each, and 20 GB ticket VMs
 * (26 GB with overhead) stopped fitting at all; 10 GB is enough for Node.js apps. Override
 * with env for heavier stacks.
 */
const gb = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 3 ? Math.floor(value) : fallback;
};
/** Fresh ticket workspaces and epic validation VMs. */
export const TICKET_VM_DISK_GB = gb('TICKET_VM_DISK_GB', 10);
/** Project preview VMs (and so every copy of one). */
export const PREVIEW_VM_DISK_GB = gb('PREVIEW_VM_DISK_GB', 10);
