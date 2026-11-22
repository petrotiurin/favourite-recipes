// `window.RecipeAuth`: the sign-in store (src/lib/auth.ts) in the shape templates/auth.cjs gave the chat. templates/chat.cjs, a classic script until
// step 8 of docs/typescript-migration.md, finds sign-in only through it. REMOVED IN STEP 8: the chat becomes components that import the store
// (and `AccountButton`) directly; then this file, `auth-boot.ts`' call to it and the global's type go.
//
//   getSession()            { email, access_token, refresh_token, expires_at } or null
//   getAccessToken()        Promise of a token that is good for at least a minute (refreshed when needed), or null
//   refresh()               Promise: force a refresh now (a server said 401); a fresh token, or null if the session can't be renewed
//   onChange(fn)            fn(session, { type }) on "sign-in", "sign-out", "refresh", "password-saved", "error" (info.message). Returns an
//                           unsubscribe function. A magic-link return that happened while the page was loading is delivered to each
//                           listener, a tick after it subscribes.
//   openSignIn({ title, lede })  opens the sheet (the copy is optional)
//   openSetPassword()       opens "Set a password" for the signed-in user
//   signOut()               signs out (tells Supabase, clears the session)
//   sessionExpired(text)    clears the session and opens the sheet with `text` as an error
//   renderAccount(el, { compact })  keeps el showing a "Sign in" pill, or the avatar with its menu
//   setCopy({ title, lede})  default sheet title and line for this page
import { h, render } from "preact";
import AccountButton from "../islands/SignIn.tsx";
import type { Auth, AuthListener, Session, SheetCopy } from "./auth.ts";

export interface RecipeAuthApi {
  getSession(): Session | null;
  getAccessToken(): Promise<string | null>;
  refresh(): Promise<string | null>;
  onChange(fn: AuthListener): () => void;
  openSignIn(copy?: SheetCopy): void;
  openSetPassword(): void;
  signOut(): void;
  sessionExpired(text: string): void;
  renderAccount(el: Element, opts?: { compact?: boolean }): void;
  setCopy(copy: SheetCopy): void;
}

declare global {
  interface Window {
    RecipeAuth?: RecipeAuthApi;
  }
}

/** Defines `window.RecipeAuth` from the store. */
export function installRecipeAuth(store: Auth, win: Window = window): RecipeAuthApi {
  const api: RecipeAuthApi = {
    getSession: store.getSession,
    getAccessToken: store.getAccessToken,
    refresh: store.refresh,
    onChange: store.onChange,
    openSignIn: (copy) => store.openSignIn(copy),
    openSetPassword: store.openSetPassword,
    signOut: store.signOut,
    sessionExpired: store.sessionExpired,
    renderAccount: (el, opts) => render(h(AccountButton, { compact: !!opts?.compact, store }), el),
    setCopy: store.setCopy,
  };
  win.RecipeAuth = api;
  return api;
}
