// The chat's icons (design.md "Icon language": stroke SVGs on a 24px grid, currentColor, aria-hidden), drawn as elements. They are the chat's
// own set (finer strokes than the house set in src/lib/icons.ts), the same drawings it always had.
import type { ComponentChildren } from "preact";

function Svg({ stroke = "1.8", children }: { stroke?: string; children: ComponentChildren }) {
  return (
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const ChatIcon = () => <Svg><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z" /></Svg>;
export const CloseIcon = () => <Svg><path d="M6 6l12 12M18 6L6 18" /></Svg>;
export const ArrowIcon = () => <Svg><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></Svg>;
export const SendIcon = () => <Svg stroke="2"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></Svg>;
export const ListIcon = () => <Svg><path d="M8 6h12M8 12h12M8 18h12" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></Svg>;
export const UpIcon = () => <Svg><path d="M7 11v9H4v-9z" /><path d="M7 11l4-7c1.7 0 2.5 1.2 2.2 2.8L12.6 10H19a1.8 1.8 0 0 1 1.8 2.1l-1.3 6.4A2 2 0 0 1 17.5 20H7" /></Svg>;
export const DownIcon = () => <Svg><path d="M7 13V4H4v9z" /><path d="M7 13l4 7c1.7 0 2.5-1.2 2.2-2.8L12.6 14H19a1.8 1.8 0 0 0 1.8-2.1l-1.3-6.4A2 2 0 0 0 17.5 4H7" /></Svg>;
export const ChevronIcon = () => <Svg><path d="m6 9 6 6 6-6" /></Svg>;
export const AttachIcon = () => <Svg><rect x="3" y="5" width="18" height="14" rx="2.5" /><circle cx="9" cy="10.5" r="1.6" /><path d="m21 16-5-5-8 8" /></Svg>;
export const TrashIcon = () => <Svg><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" /></Svg>;
/** The tick in the optional items' boxes (no class: the box styles it). */
export const TickIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);
