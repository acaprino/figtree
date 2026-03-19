/**
 * Native notification helper — fires Windows toast notifications
 * when the app window is not focused and Claude needs attention.
 */
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

let permissionGranted = false;

async function ensurePermission(): Promise<boolean> {
  if (permissionGranted) return true;
  try {
    const granted = await isPermissionGranted();
    if (granted) { permissionGranted = true; return true; }
    const result = await requestPermission();
    if (result === "granted") { permissionGranted = true; return true; }
    return false;
  } catch (err) {
    console.debug("[notify] permission check/request failed:", err);
    return false;
  }
}

let lastNotifyTime = 0;

export async function notifyAttention(title: string, body: string, force = false): Promise<void> {
  if (!force && document.hasFocus()) return;
  const now = Date.now();
  if (now - lastNotifyTime < 3000) return;
  try {
    if (!(await ensurePermission())) return;
    lastNotifyTime = now;
    sendNotification({ title, body });
  } catch (err) { console.debug("[notify] sendNotification failed:", err); }
}
