# flipchart bot 📋

A Discord bot for whiteboards that fill up slowly. Someone puts a blank flipchart in a channel; anyone who wanders past can add to it, over an afternoon or over a fortnight. Nobody has to be in a call, or online at the same time, or willing to put their name to it.

```
/flipchart new title:Retro — what should we stop doing?

📋 Retro — what should we stop doing?
Add a sticky whenever something occurs to you.

[ the board so far, as an image ]

7 contributors · anyone here can add to it, anonymously
                                  [ 🖊️ Add to this flipchart ]  [ Just look ]
```

The message says the bot posted it. It doesn't say who ran the command, and it never says who drew what.

## Commands

| Command | What it does |
| --- | --- |
| `/flipchart new title:<text> [prompt:<text>] [sign:<bool>]` | Put a blank flipchart in this channel. Anonymous unless you set `sign`. |
| `/flipchart list` | Flipcharts still open in this server, with links. Replies privately. |
| `/flipchart link flipchart:<board>` | Get your private link back, if you lost it. |
| `/flipchart close flipchart:<board>` | Stop it accepting changes. It stays visible. |
| `/flipchart reopen flipchart:<board>` | Let people add to it again. |
| `/flipchart block user:<member>` | Stop someone contributing. Needs **Manage Messages**. |
| `/flipchart unblock user:<member>` | Let them contribute again. |

Every reply is ephemeral — only you see it. That is deliberate: if the bot answered publicly, watching the channel would tell you who was about to draw something.

## How the anonymity actually works

This is the part worth understanding before you trust it with anything sensitive.

**The bot never stores a Discord user ID next to anything anyone drew.** Instead it stores one-way HMACs, keyed by `FLIPCHART_SECRET`:

```
participant key   HMAC(secret, "participant:<boardId>:<userId>")
member key        HMAC(secret, "member:<guildId>:<userId>")
```

A participant key is scoped to **one board**. So the same person is a stable pseudonym — `opal osprey`, with a matching cursor colour — for the whole week they keep coming back to that flipchart, and is a completely unrelated pseudonym on the next one. Anyone holding a copy of the database but not `FLIPCHART_SECRET` — a leak, a stolen backup, a curious member — learns nothing from it at all, and cannot link two boards together.

Anyone holding the *secret* is a different matter. See the limits below before you promise anyone more than this delivers.

Nothing is reversible. Moderation works by recomputation rather than lookup:

- **"Did you start this board?"** — recompute your participant key for that board and compare it to the stored one.
- **"Are you blocked?"** — recompute your member key for that server and check the blocklist.

Neither needs a table mapping keys back to people, so there isn't one.

**Getting onto a board.** Clicking *Add to this flipchart* doesn't take you anywhere directly. The bot replies ephemerally with a signed, personal link, and that link is what the websocket checks. The token lives in the URL **fragment** (`#t=…`), which browsers never transmit — so it stays out of server logs, referrer headers and any proxy in between. The page reads it, then wipes it from the address bar.

### What this does not protect against

Worth being straight about the edges:

- **Handwriting and phrasing.** The strongest deanonymiser here is style, and no amount of cryptography touches it. On a board of eight people, one distinctive scrawl is recognisable.
- **Timing.** Someone watching both the channel and the board closely could correlate "X was typing" with a sticky appearing. Presence is live while people are drawing.
- **Whoever runs the server.** This is the big one, and the one-way HMAC does *not* save you here. The keys can't be reversed, but they don't need to be: a server has maybe fifty members, so the operator can simply compute the key for every one of them and look for a match. That recovers who contributed to a board, and — by doing it on two boards — links them together. A hash only anonymises when the space of possible inputs is too large to enumerate, and a member list is nowhere near that. **Anonymity here is against other members, not against the operator.**
- **Pasted images.** Filenames are stripped to just the extension before upload, but the bot cannot inspect what's *in* an image. A pasted screenshot with a name in it is a screenshot with a name in it.

If any of that matters for your use, say so where people can see it.

## Running it locally

Requires **Node 20+**.

**1. Install and build**

```bash
git clone https://github.com/ameletto/flipchart-bot.git
cd flipchart-bot && npm install && npm run build
```

`npm run build` bundles the whiteboard itself. Re-run it whenever you change anything under `web/`.

**2. Create the Discord application**

At the [Developer Portal](https://discord.com/developers/applications): **New Application** → **Bot** → **Reset Token**, and copy the token.

> **Create a new application — don't reuse one you already have.** `npm run deploy` sends a `PUT` of the whole command set for that `DISCORD_CLIENT_ID`, which *replaces* every command the application had. Point it at an existing bot and you will wipe that bot's commands.

Unlike teabot, **no privileged intents are needed** — leave Server Members, Message Content and Presence all off. The bot never reads messages and never enumerates members.

Then **Installation** → enable the `bot` and `applications.commands` scopes, and open the generated install link. `Send Messages` and `Embed Links` are the only permissions it needs.

**3. Configure**

```bash
cp .env.example .env
```

| Variable | Where it comes from |
| --- | --- |
| `DISCORD_TOKEN` | Developer Portal → Bot → Reset Token |
| `DISCORD_CLIENT_ID` | Developer Portal → General Information → Application ID |
| `DISCORD_GUILD_ID` | Right-click your server → Copy Server ID (enable Developer Mode first) |
| `FLIPCHART_PUBLIC_URL` | The public address people will open, e.g. `https://flipchart.example.com` |
| `FLIPCHART_SECRET` | Generate one: `openssl rand -hex 32` |

`FLIPCHART_SECRET` is load-bearing. It signs every link and derives every pseudonym, so changing it invalidates outstanding links and reshuffles everyone's anonymous names mid-board. Set it once and back it up.

**4. Register the commands, then run**

```bash
npm run deploy
npm start
```

There's a smoke test that needs no Discord credentials and no network. It covers the anonymity model, the embed and link rendering, every web route, and a real tldraw sync connection:

```bash
npm test
```

For local development the public URL has to be reachable from a browser, which for testing means a tunnel:

```bash
cloudflared tunnel --url http://localhost:3000
```

Put the address it prints into `FLIPCHART_PUBLIC_URL` and restart. Plain `http://localhost:3000` works too if you only ever open it on the same machine.

### Optional settings

| Variable | Default | Effect |
| --- | --- | --- |
| `FLIPCHART_PORT` | `3000` | Port the web server binds to |
| `FLIPCHART_DATA_DIR` | `./data` | Where boards, previews and uploads live |
| `FLIPCHART_LINK_TTL_MINUTES` | `10080` (7 days) | How long a personal link stays valid |
| `FLIPCHART_PREVIEW_INTERVAL_SECONDS` | `90` | Minimum gap between edits to a flipchart's Discord message |
| `FLIPCHART_ROOM_IDLE_MINUTES` | `10` | How long an empty board stays in memory before unloading |
| `FLIPCHART_MAX_UPLOAD_MB` | `8` | Ceiling on a pasted image or an uploaded preview |

## Hosting it

**This part is genuinely different from teabot.** teabot only makes outbound connections, so it needs no domain, no certificate and no open ports. flipchart bot serves a website that people open in a browser, and it holds two kinds of long-lived connection at once: the Discord gateway, and a websocket per contributor.

That rules out serverless. **Vercel can't run this** — Vercel Functions can't hold the Discord gateway connection open, can't act as a long-lived websocket server (connections are pinned to a function and inherit its duration limit), and have an ephemeral filesystem, so the SQLite files would vanish between deploys. Making it work there means a different application: HTTP interactions instead of the gateway, a hosted realtime provider instead of tldraw's own sync server, and Postgres plus blob storage instead of SQLite. That's a rewrite, not a deployment.

Anything that runs a **long-lived container with a disk** is a good fit. Two documented paths:

### Railway (easiest)

Railway runs the process as-is, gives you HTTPS on a `*.up.railway.app` domain for free, and supports websockets. No Caddy, no certificates, no firewall rules.

1. **Push this repo to GitHub**, then in Railway: **New Project → Deploy from GitHub repo**. Nixpacks detects Node, runs `npm run build`, then `npm start`.

2. **Attach a volume** — service → **Variables/Settings → Volumes → Add volume**, mounted anywhere (`/data` is fine). This is not optional: without it, every deploy wipes every flipchart. Railway sets `RAILWAY_VOLUME_MOUNT_PATH`, which the app picks up automatically.

3. **Set variables:**

   | Variable | Value |
   | --- | --- |
   | `DISCORD_TOKEN` | from the Developer Portal |
   | `DISCORD_CLIENT_ID` | your Application ID |
   | `DISCORD_GUILD_ID` | your server ID, for instant commands |
   | `FLIPCHART_SECRET` | `openssl rand -hex 32` |
   | `FLIPCHART_SYNC_COMMANDS` | `true` |

   Leave `FLIPCHART_PUBLIC_URL` unset. Railway assigns the domain only after the first deploy, so the app falls back to `RAILWAY_PUBLIC_DOMAIN` on its own. Set it explicitly later if you attach a custom domain.

   `FLIPCHART_SYNC_COMMANDS=true` registers the slash commands on boot, which saves running a one-off command. `PORT` is injected by Railway and takes precedence over `FLIPCHART_PORT`.

4. **Generate a domain** under **Settings → Networking** if Railway hasn't already, then check `https://<your-domain>/healthz` returns `ok`.

Fly.io, a cheap VPS or your own box all work on the same terms: one process, one persistent disk, HTTPS in front.

Free tiers that **don't** work are worth knowing about too. Render's free web services sleep after inactivity, which drops the Discord gateway connection and every open board, and give you no persistent disk. Fly.io no longer has a standing free allowance. Anything that scales to zero is unsuitable, because this process has to stay up.

### Google Cloud free tier ($0, forever)

Genuinely free — no domain purchase required, see below — but you assemble it yourself. You need a **hostname** with an A record, **HTTPS**, and **ports 80 and 443** open.

The same always-free `e2-micro` that runs teabot is enough. Follow teabot's VM creation steps — same region list (`us-west1`, `us-central1` or `us-east1`), same `e2-micro`, same **Standard persistent disk**, 30 GB, Ubuntu 24.04 — and additionally tick **Allow HTTP traffic** and **Allow HTTPS traffic**. Reserve a **static** external IP, or the address changes on reboot.

Oracle Cloud's Always Free tier is the other option, and more generous — though it was cut to 2 Arm cores and 12 GB in June 2026. Both providers want a credit card on file even though neither charges you.

#### Running it alongside another bot on the same VM

Google's always-free tier covers **one** `e2-micro` per month, so a second VM is billed. If you already have one running something else, put this on it rather than paying — `deploy/setup-vm.sh` is written to be re-runnable on a machine that's already set up. It skips the swapfile if one exists, skips Node if it's current, and installs its own `flipchart` systemd unit, independent of anything else. There's no port conflict with a bot that only makes outbound connections.

Two things do need changing on an existing VM, both editable in place:

- **Open HTTP/HTTPS.** A bot that never served a website won't have them open. Edit the instance and tick **Allow HTTP traffic** and **Allow HTTPS traffic**.
- **Make the external IP static**, or it changes on reboot and your hostname silently points nowhere.

What you give up is isolation: an out-of-memory kill takes both processes with it, and the machine is now reachable from the internet where it may not have been before.

#### If you use Oracle, open the firewall twice

This is the single most common way to lose an evening on Oracle, and it doesn't apply to Google. Oracle instances have **two** firewalls, and opening only the obvious one leaves the site unreachable with no useful error:

1. **The cloud firewall.** Networking → your VCN → Security List → add ingress rules for source `0.0.0.0/0`, TCP, ports 80 and 443. This is the one people find.
2. **The host firewall.** Oracle's Ubuntu images ship with iptables rules that accept SSH and little else. `ufw` is disabled by default here and fighting it causes more problems than it solves, so edit iptables directly.

Look at the existing rules before touching anything — you are one bad rule away from locking yourself out of SSH:

```bash
sudo iptables -L INPUT --line-numbers
```

Insert the two rules *above* the final REJECT line (substitute its number for `6` if it differs), then persist them:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

`deploy/setup-vm.sh` deliberately does **not** do this for you. Rewriting a firewall unattended is how people lose access to their own machine, and the rule positions differ between images.

To tell the two layers apart when it's still not working: run `sudo tcpdump -i any port 80` and load the site. Packets arriving means the cloud firewall is fine and the host firewall is blocking. Nothing arriving means it never got past Oracle.

#### You don't have to buy a domain

Caddy will get a Let's Encrypt certificate for any hostname that resolves to the machine, and a free one works as well as a paid one. [DuckDNS](https://www.duckdns.org) hands out `something.duckdns.org` subdomains for nothing: sign in with an account you already have, pick a name, and put the VM's static **external** IP in the address field.

> Watch that field — DuckDNS pre-fills it with the IP of whatever machine you're browsing from, which is your laptop, not your server. Leaving it means the name points at your house and Caddy can't get a certificate.

Confirm it resolves *before* deploying, since Caddy needs the name working to complete the challenge:

```bash
dig +short something.duckdns.org      # should print the VM's external IP
```

Then set

```
FLIPCHART_PUBLIC_URL=https://something.duckdns.org
```

and the setup script does the rest — no plugins and no extra configuration, because port 80 is open and Caddy can complete the ordinary HTTP challenge.

The trade is reliability: DuckDNS is a free service that occasionally has DNS hiccups, and if it can't resolve, Caddy can't renew. For a server hobby project that's fine. For anything people depend on, a real domain is about £10/year and removes the whole category of problem.

Then point your hostname's A record at the VM's external IP and:

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/ameletto/flipchart-bot.git
cd flipchart-bot && cp .env.example .env && nano .env
```

Fill in `.env` — including `FLIPCHART_PUBLIC_URL` with your hostname, DuckDNS or otherwise — then:

```bash
bash deploy/setup-vm.sh
```

That installs Node, builds the whiteboard, registers the commands, installs Caddy for automatic TLS, and sets the bot up as a service that restarts on crash and reboot. It reads the domain straight out of `.env` so the two can't drift apart.

Check it from the outside:

```bash
curl https://your-domain/healthz
```

### Day-to-day on the VM

```bash
sudo systemctl restart flipchart    # after changes
sudo journalctl -u flipchart -f     # follow logs
sudo journalctl -u caddy -f         # certificate problems show up here
```

To update: `git pull`, then `npm ci && npm run build` if anything changed, then restart.

### Wherever you host it

Back up the data directory — it holds every flipchart. Each board is a self-contained SQLite file under `boards/`, so a single flipchart can be copied or deleted on its own.

Two settings are load-bearing across a redeploy, and getting either wrong loses work:

- **The data directory must be on persistent storage.** A container filesystem is not. On Railway that means an attached volume; on a VM it's just the disk.
- **`FLIPCHART_SECRET` must stay the same.** It signs every outstanding link and derives every pseudonym, so changing it invalidates links people are still holding and reshuffles everyone's anonymous names mid-board.

## How a board stays in sync

Contributors connect over a websocket to a [tldraw sync](https://tldraw.dev) room, which is what makes it safe for two people to be on the same board at once without overwriting each other — and what lets someone close the tab on Tuesday and pick it up on Friday. Every edit is written to that board's SQLite file as it happens, so nothing is held only in memory. A board with nobody on it unloads after ten minutes and costs nothing until someone opens it again.

The preview image in Discord is rendered by a **contributor's own browser** — tldraw exports the canvas to PNG and posts it to the bot — which is why there's no headless Chrome on the server. Message edits are throttled to one per board per `FLIPCHART_PREVIEW_INTERVAL_SECONDS`, and the URL carries a `?v=` counter because Discord caches embed images hard.

## A note on the tldraw licence

The whiteboard is the [tldraw SDK](https://tldraw.dev), which is not MIT — it ships under [tldraw's own licence](https://github.com/tldraw/tldraw/blob/main/LICENSE.md) and renders a small "made with tldraw" watermark unless you pass a `licenseKey`. For a community Discord bot that's usually fine, and leaving the watermark on is the path of least resistance. **If you're putting this somewhere commercial, read their licence and talk to them first** — that's their call to make, not this README's.

If the watermark or the licence is a problem, [Excalidraw](https://github.com/excalidraw/excalidraw) is MIT and would slot into the same architecture, though you'd have to write the sync layer that tldraw gives you here for free.

## Project layout

```
src/
  index.js              starts the web server and the bot, flushes boards on shutdown
  config.js             environment parsing
  db.js                 SQLite schema for board metadata
  identity.js           HMAC pseudonyms and signed links — the anonymity model
  discord/
    client.js           the discord.js client
    bot.js              interaction router, login
    deploy-commands.js  registers slash commands with Discord
    board-message.js    the embed, and keeping it up to date
    links.js            minting personal contribution links
    commands/           one file per slash command
  web/
    server.js           express routes, websocket upgrade, auth
    rooms.js            tldraw sync rooms, one SQLite file per board
    preview.js          receives previews, throttles Discord edits
web/
  src/Board.jsx         the whiteboard page
test/
  smoke.mjs             everything testable without a Discord login
deploy/
  setup-vm.sh           one-shot server setup
  flipchart.service     systemd unit
  Caddyfile             TLS termination
```

Adding a command means dropping a file in `src/discord/commands/` that exports `data` (a `SlashCommandBuilder`) and `execute(interaction)`, listing it in the `commands` array in `src/discord/bot.js`, then re-running `npm run deploy`.

## License

MIT — see [LICENSE](LICENSE). The tldraw SDK it depends on is licensed separately; see the note above.
