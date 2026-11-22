// Starts sign-in on a page of a build that has the Supabase values (the layout writes `#auth-config`, JSON, only then, and this script only then).
// A module script in the head, not an island: it starts the store before any island wakes (the chat island and the shopping page's account
// button read the session as they do), and mounts the one sign-in sheet, and nothing else.
import { h, render } from "preact";
import { SignInSheet } from "../islands/SignIn.tsx";
import { auth } from "./auth.ts";

const config = (() => {
  try {
    return JSON.parse(document.getElementById("auth-config")?.textContent || "null") as { supabaseUrl?: unknown; supabaseKey?: unknown } | null;
  } catch {
    return null;
  }
})();
if (config && typeof config.supabaseUrl === "string" && config.supabaseUrl && typeof config.supabaseKey === "string" && config.supabaseKey) {
  auth.init({ supabaseUrl: config.supabaseUrl, supabaseKey: config.supabaseKey });
  const root = document.createElement("div");
  root.id = "auth-sheet-root";
  document.body.appendChild(root);
  render(h(SignInSheet, { store: auth }), root);
}
