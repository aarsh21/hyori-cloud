import { statfsSync } from "node:fs";

export class InsufficientBackupSpace extends Error {
  constructor() {
    super("insufficient_space");
  }
}

/** Keep backup writes above the operator reserve, with 64 KiB extra for filesystem metadata. */
export function checkBackupSpace(path: string, bytes = 0) {
  const percent = Number(process.env.HYORI_BACKUP_RESERVE_PERCENT ?? 25);

  if (!Number.isInteger(percent) || percent <= 15 || percent >= 100)
    throw new Error("HYORI_BACKUP_RESERVE_PERCENT must be an integer from 16 to 99.");

  const fs = statfsSync(path, { bigint: true });
  const reserve = (fs.blocks * fs.bsize * BigInt(percent) + 99n) / 100n;
  const allocation = ((BigInt(bytes) + fs.bsize - 1n) / fs.bsize) * fs.bsize;

  if (fs.bavail * fs.bsize - allocation - 65536n < reserve) throw new InsufficientBackupSpace();
}
