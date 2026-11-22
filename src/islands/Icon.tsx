// An icon from the house set (src/lib/icons.ts) for the islands: the same <svg> as components/Icon.astro. The paths are constants from
// that file, never user or model text, so setting them as markup is safe.
import { ICONS, type IconName } from "../lib/icons.ts";

export default function Icon({ name, class: cls = "icon" }: { name: IconName; class?: string }) {
  const { stroke, paths, filled } = ICONS[name];
  return (
    <svg
      class={cls}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      stroke-width={stroke}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: paths }}
    />
  );
}
