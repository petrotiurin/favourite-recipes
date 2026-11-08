// The chat's on/off switches (Vercel environment variables, read on every request so a redeploy with a new value is all it takes):
//   CHAT_ENABLED         default on; "false" / "0" / "off" / "no" switches every /chat route off (503 { disabled: true }) before any other work
//   CHAT_PUBLIC_ENABLED  default on; when off the chat is for signed-in editors only (visitors and non-editor accounts get 403 { signin: true })
const OFF = /^(false|0|off|no)$/i;
const on = (name) => !OFF.test(String(process.env[name] ?? "true").trim());

export const chatEnabled = () => on("CHAT_ENABLED");
export const publicChatEnabled = () => on("CHAT_PUBLIC_ENABLED");

export const DISABLED_BODY = { error: "The chat is switched off.", disabled: true };
export const SIGNIN_BODY = { error: "The chat is only for signed-in editors.", signin: true };
