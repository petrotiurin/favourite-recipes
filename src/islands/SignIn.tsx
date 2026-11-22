// Sign-in's two parts, drawn from the store in src/lib/auth.ts (docs/typescript-migration.md 4.6):
// - `AccountButton` (the default export, an island on the shopping page): the "Sign in" pill, or the avatar with its menu (email, Set a password,
//   Sign out). The chat draws it into its own header through the window.RecipeAuth shim (src/lib/recipe-auth.ts, `compact`: the icon alone).
// - `SignInSheet`: the sheet that slides up (email + password, the emailed code, Set a password). One per page, mounted by src/lib/auth-boot.ts.
// Same classes and `data-auth` hooks as the script they replace (the chat finds its Sign in button by `data-auth="signin"`).
import { Fragment } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { auth as siteAuth, type Auth } from "../lib/auth.ts";
import { useHydrated } from "../lib/hydrated.ts";
import Icon from "./Icon.tsx";

interface Props {
  /** The icon alone, for the chat's header. */
  compact?: boolean;
  /** Only tests pass another store. */
  store?: Auth;
}

export default function AccountButton({ compact = false, store = siteAuth }: Props) {
  const hydrated = useHydrated();
  const session = hydrated ? store.session.value : null;
  if (!session) {
    return (
      <button type="button" class={`pill${compact ? " is-compact" : ""}`} data-auth="signin" aria-label={compact ? "Sign in" : undefined} onClick={() => store.openSignIn()}>
        <Icon name="person" />
        {compact ? "" : "Sign in"}
      </button>
    );
  }
  const email = session.email || "";
  const open = store.accountOpen.value;
  return (
    <>
      <button type="button" class="avatar" data-auth="account" aria-expanded={tf(open)} aria-label={`Signed in as ${email || "editor"}`} onClick={store.toggleAccount}>
        {(email || "E").charAt(0).toUpperCase()}
      </button>
      {open && (
        <div class="account-menu">
          <p>Signed in as {email || "editor"}</p>
          <button type="button" class="text-button" data-auth="set-password" onClick={store.openSetPassword}>Set a password</button>
          <button type="button" class="text-button" data-auth="signout" onClick={store.signOut}>Sign out</button>
        </div>
      )}
    </>
  );
}

const tf = (b: boolean): "true" | "false" => (b ? "true" : "false");
const value = (form: HTMLFormElement, id: string) => (form.querySelector(`#${id}`) as HTMLInputElement | null)?.value ?? "";

export function SignInSheet({ store = siteAuth }: { store?: Auth }) {
  const kind = store.sheet.value;
  const sheetRef = useRef<HTMLDivElement>(null);
  // A sheet being open stops the page behind it from scrolling and moves the chat's bubble out of the way (CSS, `body.sheet-open`).
  useLayoutEffect(() => {
    document.body.classList.toggle("sheet-open", !!kind);
    return () => document.body.classList.remove("sheet-open");
  }, [kind]);
  // An open sheet keeps focus inside it: on its first empty field, unless something in it already has focus.
  useLayoutEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet || sheet.contains(document.activeElement)) return;
    const fields = [...sheet.querySelectorAll<HTMLInputElement>("input:not([hidden])")];
    (fields.find((f) => !f.value) ?? fields[0])?.focus();
  });
  if (!kind) return null;

  const copy = store.override.value ?? store.copy.value;
  const message = store.message.value;
  const busy = store.busy.value;
  const email = store.email.value;
  const lede = {
    email: copy.lede,
    code: `We sent a code to ${email}. It works on any device.`,
    password: "Next time, sign in with your email and this password: no email to wait for.",
  }[kind];
  const submit = (idle: string, working: string) => (
    <button type="submit" class="save-button" disabled={busy}>{busy ? working : idle}</button>
  );

  let form;
  if (kind === "email") {
    // The links and the note sit under the form, not in it (as they always did).
    form = (
      <Fragment key="email">
        <form
          data-auth-form="email"
          onSubmit={(e) => {
            e.preventDefault();
            const f = e.currentTarget as HTMLFormElement;
            store.email.value = value(f, "signin-email").trim();
            store.password.value = value(f, "signin-password");
            if (store.email.value && store.password.value) void store.signInWithPassword();
          }}
        >
          <label for="signin-email">Email</label>
          <input id="signin-email" type="email" autocomplete="username" required value={email} onInput={(e) => (store.email.value = e.currentTarget.value.trim())} />
          <label for="signin-password">Password</label>
          <input id="signin-password" type="password" autocomplete="current-password" required value={store.password.value} onInput={(e) => (store.password.value = e.currentTarget.value)} />
          {submit("Sign in", "Signing in…")}
        </form>
        <div class="sheet-links">
          <button
            type="button"
            class="text-button"
            data-auth="send-code"
            disabled={busy}
            onClick={() => {
              const input = document.getElementById("signin-email") as HTMLInputElement;
              if (!input.reportValidity()) return;
              store.email.value = input.value.trim();
              void store.sendCode();
            }}
          >
            No password? Email me a code
          </button>
        </div>
        <p class="sheet-note">Only family editors can sign in. You'll stay signed in on this device.</p>
      </Fragment>
    );
  } else if (kind === "code") {
    form = (
      <Fragment key="code">
        <form
          data-auth-form="code"
          onSubmit={(e) => {
            e.preventDefault();
            store.code.value = value(e.currentTarget as HTMLFormElement, "signin-code").replace(/\D/g, "");
            if (store.code.value) void store.verifyCode();
          }}
        >
          <label for="signin-code">Code from the email</label>
          <input id="signin-code" class="code-input" inputMode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxLength={10} required value={store.code.value} onInput={(e) => (store.code.value = e.currentTarget.value.replace(/\D/g, ""))} />
          {submit("Sign in", "Signing in…")}
        </form>
        <div class="sheet-links">
          <button type="button" class="text-button is-quiet" data-auth="sheet-email" onClick={store.showEmailSheet}>Change email</button>
          <button type="button" class="text-button" data-auth="resend" disabled={busy} onClick={() => void store.sendCode()}>Send a new code</button>
        </div>
        <p class="sheet-note">The email also has a sign-in link, if you'd rather tap that on this device.</p>
      </Fragment>
    );
  } else {
    // The hidden username lets password managers file the new password under the right email.
    form = (
      <Fragment key="password">
        <form
          data-auth-form="password"
          onSubmit={(e) => {
            e.preventDefault();
            store.password.value = value(e.currentTarget as HTMLFormElement, "new-password");
            if (store.password.value) void store.setPassword();
          }}
        >
          <input type="email" autocomplete="username" value={store.session.value?.email || email} hidden />
          <label for="new-password">New password</label>
          <input id="new-password" type="password" autocomplete="new-password" minLength={6} required value={store.password.value} onInput={(e) => (store.password.value = e.currentTarget.value)} />
          {submit("Save password", "Saving…")}
        </form>
        <div class="sheet-links">
          <button type="button" class="text-button is-quiet" data-auth="sheet-close" onClick={store.closeSheet}>Not now</button>
        </div>
        <p class="sheet-note">Let your browser save it. The email code still works if you forget it.</p>
      </Fragment>
    );
  }

  return (
    <div class="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && store.closeSheet()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" ref={sheetRef}>
        <span class="sheet-grip" aria-hidden="true" />
        <div class="sheet-head">
          <div>
            <h2 id="sheet-title">{kind === "password" ? "Set a password" : copy.title}</h2>
            <p>{lede}</p>
          </div>
          <button type="button" class="icon-button" data-auth="sheet-close" aria-label="Close" onClick={store.closeSheet}>
            <Icon name="close" />
          </button>
        </div>
        {message && (
          <p class={`shopping-status${message.error ? " is-error" : ""}`} role="status">{message.text}</p>
        )}
        {form}
      </div>
    </div>
  );
}
