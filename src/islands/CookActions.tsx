// The pills in the recipe page's cook bar (`client:visible`): "Keep screen on" and "Cook with Claude", side by side. One island, so there is
// always something in it for the browser to watch come into view (`client:visible` watches the island's elements).
import CookClaude, { type CookClaudeProps } from "./CookClaude.tsx";
import WakeLock from "./WakeLock.tsx";

export default function CookActions(props: CookClaudeProps) {
  return (
    <>
      <WakeLock />
      <CookClaude {...props} />
    </>
  );
}
