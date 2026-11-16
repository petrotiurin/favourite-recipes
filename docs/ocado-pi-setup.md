# Ocado reader on a Raspberry Pi: setup guide

Ocado shows each item's use-by date only after delivery, on the signed-in order page (`ocado.com/orders/<order no>/details`).
The emails don't carry the dates (they list the products and substitutions only), and logging in from a cloud server would mean
storing the Ocado password, handling the one-time code and fighting reCAPTCHA from a data-centre IP. So a Raspberry Pi at home
runs a Chromium that **we log in to once, by hand**, and keeps the session. A script on the Pi reads new delivered orders and
sends the dates to our backend.

```
Raspberry Pi 4 (8 GB), at home                     Vercel backend           Supabase
┌──────────────────────────────────┐  HTTPS out    ┌──────────────┐         ┌──────────────┐
│ Chromium, own profile, logged in │ ────────────▶ │ POST /pantry │ ──────▶ │ pantry_items │
│ to Ocado (by you, via Pi Connect)│  Pi token     └──────────────┘         └──────────────┘
│ systemd timer: reader script     │                                               ▲
└──────────────────────────────────┘                       site / chat read ───────┘
      ▲ Raspberry Pi Connect: desktop + shell in your browser; nothing opened on the router
```

Rules this keeps:

- **No Ocado password is stored anywhere.** Only Chromium's session cookies live on the Pi.
- **The Pi only makes outgoing calls.** Its one credential is a Pi token that can do nothing but write the pantry. The backend
  stays the only place with real secrets and the only writer to the repo.
- **The pantry lives in Supabase, not git.** Updating it never triggers a site deploy.

Status: this guide covers the Pi itself and a first capture of a real order page. `POST /pantry`, the `pantry_items` table and
the reader script get built once we've seen a captured page (step 9), since the layout of the dates is still unknown.

## 1. Hardware

- **The Raspberry Pi 4 Model B, 8 GB** (one of the boards from the old cluster). The 4 GB one also works if needed. Don't use
  the 2 GB or 1 GB boards: Chromium with a desktop is too much for them.
- The official 5.1 V / 3 A USB-C power supply. Weak supplies cause random crashes under Chromium.
- Storage: a good A2 microSD card of 32 GB or more is fine. A USB 3 SSD lasts longer if it runs for years.
- Ethernet to the router if you can, otherwise Wi-Fi.
- Cooling: the fans from the cluster case, or any case with a heatsink.

## 2. Flash Raspberry Pi OS

With **Raspberry Pi Imager** on your laptop:

1. Device: Raspberry Pi 4. OS: **Raspberry Pi OS (64-bit)**, the version *with desktop*. We need the desktop to log in to Ocado.
2. Edit settings (OS customisation):
   - hostname `pantry-pi`
   - a username of your choice (this guide uses `kitchen`) and a strong password
   - Wi-Fi if you're not on Ethernet; locale `Europe/London`, keyboard `gb`
   - Services: enable SSH, **public-key authentication only**, and paste your laptop's public key (`~/.ssh/id_ed25519.pub`)
3. Write the card, put it in the Pi and boot it.

The first time, SSH in from your home network: `ssh kitchen@pantry-pi.local`.

## 3. Update and harden

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y unattended-upgrades ufw
sudo dpkg-reconfigure -plow unattended-upgrades   # answer Yes: security updates install themselves
```

Check that SSH refuses passwords (Imager normally sets this already):

```bash
grep -E '^PasswordAuthentication' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/* 2>/dev/null   # want: no
```

## 4. Desktop autologin and Raspberry Pi Connect (remote access)

**Raspberry Pi Connect** is Raspberry Pi's own remote-access service. It gives you the Pi's desktop (screen sharing) and a terminal
(remote shell) in any browser, on your laptop or phone, from anywhere. There's nothing to install on your devices, no ports to
forward on the router, and it works behind CGNAT. Its connections are encrypted end to end (WebRTC). They go directly between the
browser and the Pi where possible, and through Raspberry Pi's relay otherwise. It's free, and the only account is a Raspberry Pi ID.

Screen sharing shares a running desktop session, so first make the Pi log in to its desktop by itself at boot:

```bash
sudo raspi-config
#   System Options → Boot / Auto Login → Desktop Autologin
#   (Advanced Options → Wayland: keep the default, Wayland. Screen sharing needs it.)
sudo reboot
```

Then turn Pi Connect on and link the Pi to your Raspberry Pi ID:

```bash
sudo apt install -y rpi-connect   # already there on recent desktop images; this just makes sure
rpi-connect on
rpi-connect signin                # open the printed link, sign in (or create a Raspberry Pi ID), name the device pantry-pi
loginctl enable-linger            # keeps the remote shell available even if the desktop session ends
rpi-connect status                # want: signed in, screen sharing and remote shell allowed
```

On your Raspberry Pi ID (id.raspberrypi.com), **turn on two-factor authentication**. That account now opens your Pi's desktop,
and the desktop holds a signed-in Ocado session.

To use it, go to **connect.raspberrypi.com**, pick `pantry-pi` and choose **Screen sharing** (the desktop, for the Ocado login) or
**Remote shell** (a terminal, for upkeep). If it won't connect, `rpi-connect doctor` on the Pi checks the network path.

The firewall can now refuse everything inbound, because Pi Connect, like the reader, only makes outgoing connections. Keep SSH
open on the home network for copying files and as a fallback:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from 192.168.0.0/16 to any port 22 proto tcp   # adjust to your home subnet
sudo ufw enable
```

## 5. Optional: Tailscale (SSH and VNC from your own tools, anywhere)

Pi Connect covers the login and the upkeep. Add Tailscale only if you want ordinary `ssh` / `scp` / a VNC client from outside
the home network, e.g. to copy captures while away. Tailscale gives the Pi a private address that only your own devices can reach.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up            # open the printed link and approve the Pi in your Tailscale account
sudo ufw allow in on tailscale0
```

Install Tailscale on your laptop and phone too, with the same account. In the Tailscale admin console, turn on **Disable key
expiry** for `pantry-pi` so it doesn't drop off after 180 days. Then `ssh kitchen@pantry-pi` (Tailscale's MagicDNS name) works
from anywhere. For a VNC client too, enable it with `sudo raspi-config` → Interface Options → VNC, and connect to `pantry-pi:5900`
(RealVNC Viewer or TigerVNC). The firewall keeps VNC reachable only through Tailscale.

## 6. Chromium, Node and a dedicated profile

```bash
sudo apt install -y chromium     # the Pi's own build; on older images the package is chromium-browser
chromium --version

# Node 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version

mkdir -p ~/ocado-reader ~/ocado-profile ~/ocado-captures
cd ~/ocado-reader && npm init -y >/dev/null && npm install playwright-core
```

Use **one Chromium profile, `~/ocado-profile`, for both the hand login and the script**, and **always the system Chromium**.
Playwright's own browser build is a different version and may not read the profile. Chromium locks a profile while it's open,
so the login window and the script never run at the same time (the script refuses if the profile is in use).

Add a login helper:

```bash
cat > ~/ocado-reader/ocado-login.sh <<'EOF'
#!/bin/sh
# Opens Chromium on the Ocado profile so you can log in by hand. Close the window when done.
exec chromium --user-data-dir="$HOME/ocado-profile" --no-first-run https://www.ocado.com/login
EOF
chmod +x ~/ocado-reader/ocado-login.sh
```

## 7. Log in to Ocado (by hand, through Pi Connect)

1. Open **Screen sharing** for `pantry-pi` on connect.raspberrypi.com, open a terminal on the Pi desktop and run `~/ocado-reader/ocado-login.sh`.
2. Accept or decline the cookie banner. Log in with your email and password, and type in the one-time code from your email.
   If there's a "Remember me" / "Keep me signed in" box, tick it.
3. Open **My orders** and check that a delivered order's details page shows the use-by dates.
4. **Close Chromium completely.** That releases the profile for the script.

This is the only time your password is typed in, and only into Ocado's own page.

## 8. Capture one order page

A small script opens an order with the saved session, headless, and saves its HTML and a full-page screenshot. That's what we
need to write the real reader.

```bash
cat > ~/ocado-reader/capture-order.mjs <<'EOF'
// Usage: node capture-order.mjs [order number]
// Without a number it captures the orders list. Saves to ~/ocado-captures/<timestamp>/.
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const order = process.argv[2];
const url = order ? `https://www.ocado.com/orders/${order}/details` : "https://www.ocado.com/orders";
const out = join(homedir(), "ocado-captures", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(out, { recursive: true });

let ctx;
try {
  ctx = await chromium.launchPersistentContext(join(homedir(), "ocado-profile"), {
    executablePath: "/usr/bin/chromium",
    headless: process.env.HEADED !== "1",
    viewport: { width: 1280, height: 1600 },
    locale: "en-GB",
  });
} catch (e) {
  console.error("Couldn't open the profile. Is the login window still open? Close Chromium and try again.\n" + e.message);
  process.exit(3);
}
try {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(3000);
  if (/sso\.ocado\.com|\/login/.test(page.url())) {
    console.error("Not logged in (landed on " + page.url() + "). Log in again through Pi Connect (step 7).");
    process.exit(2);
  }
  writeFileSync(join(out, "page.html"), await page.content());
  await page.screenshot({ path: join(out, "page.png"), fullPage: true });
  console.log("Saved " + out);
} finally {
  await ctx.close();
}
EOF
cd ~/ocado-reader && node capture-order.mjs <order number>
```

The order number is in the "Your receipt and updates for today's delivery" email. If the headless run is blocked or comes back
empty, run it on the desktop instead: `HEADED=1 WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/$(id -u) node capture-order.mjs <no>`
(the window shows up in screen sharing). That tells us whether the real reader must run headed.

## 9. Hand the capture over

Copy the capture to your laptop at home (`scp -r kitchen@pantry-pi.local:ocado-captures/<timestamp> .`, or `pantry-pi`
over Tailscale) and share it in a Claude Code session, or connect the Pi to a session through Remote Control so the session can read it directly. The page has your name,
address and order. Keep it out of the repo: the code gets built from it, but the capture itself isn't committed.

## 10. Next: the reader (to be built)

Once the page layout is known, the plan is:

- **`~/ocado-reader/reader.mjs`**: opens `ocado.com/orders`, finds delivered orders it hasn't sent yet (a small state file on the
  Pi), reads every item's name, quantity and use-by date from each details page, and POSTs them to `/pantry`. It never clicks
  anything that changes the order.
- **Backend `POST /pantry`**: authenticated by a Pi-only token (`PANTRY_PI_TOKEN` on Vercel, the same value in a `chmod 600`
  `/etc/ocado-reader.env` on the Pi). It matches Ocado product names to our ingredient names (with OpenRouter, caching each match)
  and writes the `pantry_items` table (a new Supabase migration; service-role key only, RLS with no policies, like the chat tables).
- **A systemd timer** (not cron): it runs the reader every couple of hours from 10:00 to 22:00, takes a lock so it never collides
  with a login window, and logs to the journal (`journalctl -u ocado-reader`).
- **When the session expires**, the reader lands on the login page. It stops, doesn't retry, and tells the backend, which flags
  it (a note in the chat or an email). You then repeat step 7. How often this happens is unknown until it's been running a while.

## Future: moving the Ocado order (`ocado-shop`) to the Pi

Today `ocado-shop` (filling the basket from the shopping list) runs through **Claude in Chrome on a laptop**, in the browser
you're signed in to Ocado with. Once the Pi holds a signed-in Ocado profile, the same Pi can fill the basket, so no laptop needs
to be on. Things to plan for when we do it:

- **What drives the browser.** Two options:
  - **Claude Code on the Pi with Remote Control.** A cloud session, or the Claude app on your phone, attaches to a folder on the
    Pi and drives the browser through a Playwright MCP server (`@playwright/mcp` pointed at `/usr/bin/chromium` and
    `~/ocado-profile`). This is the most likely route.
  - **The Claude in Chrome extension in the Pi's Chromium.** This keeps today's tools as they are, but whether the extension
    supports Chromium on Linux/arm64 needs checking first.
- **The workflow source stays in one place.** `mcp-server/workflows/ocado-shop.md` keeps the rules (favourites first, picking
  rules, non-negotiables, never check out). Only its "Tips that save time" section is specific to Claude in Chrome, and it would
  get a Playwright counterpart. The shared rules in `workflows/shared/` don't change.
- **One profile, one user at a time.** The basket filler and the use-by reader share `~/ocado-profile`, so they share the lock:
  the reader's timer skips a run while a shop is in progress.
- **Still never checks out.** That rule doesn't change with the machine. You review the basket and pay yourself, on your phone or
  laptop. The session cookies are the same account, so the basket the Pi filled is the one you see.
- **Memory.** An 8 GB Pi 4 runs Chromium plus Claude Code comfortably. The 4 GB board would be tight with a long favourites page.
- **Sainsbury's** could move the same way later, with its own profile (`~/sainsburys-profile`) and its own login by hand through Pi Connect.
