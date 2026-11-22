// "Keep screen on" (Screen Wake Lock API), a pill in the cook bar. Part of the CookActions island. A browser without the API gets no button.
import { useEffect, useRef, useState } from "preact/hooks";
import Icon from "./Icon.tsx";

export default function WakeLock() {
  // The button is written at build time (the build can't know the browser), and taken away again where the API is missing.
  const [supported, setSupported] = useState(true);
  const [wanted, setWanted] = useState(false);
  const lock = useRef<WakeLockSentinel | null>(null);
  const wantedRef = useRef(wanted);
  wantedRef.current = wanted;

  const acquire = () => {
    navigator.wakeLock.request("screen").then(
      (l) => {
        lock.current = l;
        l.addEventListener("release", () => {
          if (lock.current === l) lock.current = null;
        });
      },
      () => setWanted(false),
    );
  };

  useEffect(() => {
    if (!("wakeLock" in navigator)) {
      setSupported(false);
      return;
    }
    // The browser drops the lock when the tab is hidden; take it back on return.
    const back = () => {
      if (wantedRef.current && !lock.current && document.visibilityState === "visible") acquire();
    };
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, []);

  if (!supported) return null;
  return (
    <button
      type="button"
      class="pill wakelock-toggle"
      aria-pressed={wanted ? "true" : "false"}
      onClick={() => {
        const next = !wanted;
        setWanted(next);
        if (next) acquire();
        else if (lock.current) {
          lock.current.release();
          lock.current = null;
        }
      }}
    >
      <Icon name="sun" />
      {wanted ? "Screen stays on" : "Keep screen on"}
    </button>
  );
}
