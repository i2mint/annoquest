/**
 * This browser's reader id when the link names none: a random id kept in this
 * origin's storage (no fingerprinting; see docs/design.md, "Identity"). Where
 * storage is refused (a private window, a sandbox), it lasts for this page load.
 */
import { newId } from '../src/request';

const KEY = 'annoquest:device';

export function deviceId(storage: () => Storage = () => localStorage): string {
  try {
    const s = storage();
    const have = s.getItem(KEY);
    if (have && /^[A-Za-z0-9_-]{8,64}$/.test(have)) return have;
    const id = newId();
    s.setItem(KEY, id);
    return id;
  } catch {
    return (memo ??= newId());
  }
}
let memo: string | undefined;

/** The reader key a device id stands for, when nothing else names the reader. */
export const deviceReader = (device: string) => `d-${device.slice(0, 12)}`;
