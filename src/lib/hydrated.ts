// A component that draws something only the browser knows (what's in localStorage, who is signed in) has to start from what the build wrote
// into the page, or Preact hydrates different markup than the page has. `useHydrated` is false for the build's render and the first browser
// render, and true right after it, before the browser paints (a layout effect), so the page never shows the in-between.
import { useLayoutEffect, useState } from "preact/hooks";

export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useLayoutEffect(() => setHydrated(true), []);
  return hydrated;
}
