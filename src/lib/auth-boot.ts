// Starts sign-in on a page of a build that has the Supabase values (the layout writes `#auth-config` only then, and this script only then).
// Not an island, on purpose: templates/chat.cjs asks for `window.RecipeAuth` and the session as it loads, and an island wakes up later than a
// deferred script runs; a module script in the head runs before the chat's script (both run in document order once the page is parsed).
// It sets up the store, the `window.RecipeAuth` shim for the chat (removed in step 8) and the one sign-in sheet, and nothing else.
import { h, render } from "preact";
import { SignInSheet } from "../islands/SignIn.tsx";
import { auth } from "./auth.ts";
import { installRecipeAuth } from "./recipe-auth.ts";

const config = document.getElementById("auth-config");
const supabaseUrl = config?.getAttribute("data-supabase-url");
const supabaseKey = config?.getAttribute("data-supabase-key");
if (supabaseUrl && supabaseKey) {
  auth.init({ supabaseUrl, supabaseKey });
  installRecipeAuth(auth);
  const root = document.createElement("div");
  root.id = "auth-sheet-root";
  document.body.appendChild(root);
  render(h(SignInSheet, { store: auth }), root);
}
