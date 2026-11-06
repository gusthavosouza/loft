import { useEffect } from "react";

/** Keep the screen awake while `on`, where the browser allows it. A refusal (no support, no permission, low battery) is ignored; the lock is asked for again when the tab comes back, as the browser drops it when hidden. */
export function useWakeLock(on: boolean) {
  useEffect(() => {
    if (!on) return;
    let lock: WakeLockSentinel | null = null;
    let stopped = false;
    const ask = () => {
      if (stopped || document.visibilityState !== "visible") return;
      navigator.wakeLock?.request("screen").then((l) => { if (stopped) l.release().catch(() => {}); else lock = l; }).catch(() => {});
    };
    ask();
    document.addEventListener("visibilitychange", ask);
    return () => { stopped = true; document.removeEventListener("visibilitychange", ask); lock?.release().catch(() => {}); };
  }, [on]);
}
