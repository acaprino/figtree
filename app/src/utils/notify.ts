/**
 * Native notification helper — fires Windows toast notifications and taskbar
 * flash when the app window is not focused and Claude needs attention.
 */
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";

const appWindow = getCurrentWindow();

let permissionGranted = false;
let toastFailCount = 0;
const MAX_TOAST_FAILURES = 3;

async function ensurePermission(): Promise<boolean> {
  if (permissionGranted) return true;
  try {
    const granted = await isPermissionGranted();
    if (granted) { permissionGranted = true; return true; }
    const result = await requestPermission();
    if (result === "granted") { permissionGranted = true; return true; }
    console.debug("[notify] permission denied:", result);
    return false;
  } catch (err) {
    console.debug("[notify] permission check/request failed:", err);
    return false;
  }
}

let lastNotifyTime = 0;

export async function notifyAttention(title: string, body: string, force = false): Promise<void> {
  // Throttle first (cheap, synchronous) to avoid async race on concurrent calls
  const now = Date.now();
  if (now - lastNotifyTime < 3000) return;
  lastNotifyTime = now; // claim the slot before any async gap

  // Use Tauri's native window focus check — document.hasFocus() is unreliable
  // in WebView and can return true even when the window is not focused.
  if (!force) {
    try {
      const focused = await appWindow.isFocused();
      if (focused) { lastNotifyTime = 0; return; } // release slot — no notification sent
    } catch (err) {
      console.debug("[notify] isFocused failed, falling back to document.hasFocus:", err);
      if (document.hasFocus()) { lastNotifyTime = 0; return; }
    }
  }

  // Always flash the taskbar icon — works in dev mode and production on Windows
  appWindow.requestUserAttention(1).catch((err) =>
    console.debug("[notify] requestUserAttention failed:", err)
  );

  // Try toast notification (may fail in dev mode on Windows without Start Menu shortcut)
  if (toastFailCount < MAX_TOAST_FAILURES) {
    try {
      if (await ensurePermission()) {
        sendNotification({ title: title.slice(0, 100), body: body.slice(0, 200) });
        toastFailCount = 0; // reset on success
      }
    } catch (err) {
      console.debug("[notify] sendNotification failed:", err);
      toastFailCount++;
    }
  }
}
