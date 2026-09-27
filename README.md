# Fyle

A tiny self-hosted file drop. Upload a file (up to 500 MB), get a short link, and that link **is the file**. There's no landing page and no download button, so it works anywhere a URL does: Downloader on a Fire TV Stick, `wget`/`curl`, VLC, a browser, or behind a link shortener that redirects to it.

- One admin account, password set in `.env`
- Sign in with the **password**, a **PIN**, or a **passkey** (Face ID / Touch ID / Windows Hello / security key); you pick which one in Settings
- Drag and drop, paste, or pick files; see progress; copy the link in one click
- Short, readable links (`files.example.com/k7m2qp`) that you can rename (`files.example.com/kodi`)
- Replace a file but keep its link, which is handy for pushing a new APK version to the same Downloader code
- Download counts, search, storage usage
- A single container with no database. Everything lives in one `./data` folder

## Quick start

```bash
git clone https://github.com/ExecSam/Fyle.git && cd Fyle
cp .env.example .env
# edit .env and set ADMIN_PASSWORD
docker compose up -d --build
```

Open `http://<your-server>:8080` and sign in with your `ADMIN_PASSWORD`.

## How links work

Every file gets a link like `https://files.example.com/k7m2qp`. Requesting it returns the file itself:

```
$ curl -I https://files.example.com/k7m2qp
HTTP/1.1 200 OK
Content-Type: application/vnd.android.package-archive
Content-Disposition: attachment; filename="app.apk"
Content-Length: 48213504
Accept-Ranges: bytes
```

- **Fire TV / Downloader:** type the link (or a shortener / Downloader code that points at it) and the APK downloads and offers to install straight away. Links are lowercase and skip look-alike characters (`0/o`, `1/l/i`) so they're easy to type with a remote. Give a file a custom link such as `/kodi` to make it even shorter.
- **Resumable:** Range requests and `HEAD` are supported, so download managers can pause, resume and split downloads.
- `/<link>/anything.apk` also works, for apps that look at the file extension in the URL.
- Links are case-insensitive.

Links are public: anyone who has one can download the file. Delete the file (or rename its link) to revoke access.

## Signing in

Go to **Settings** and choose a method:

| Method   | How it works                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------- |
| Password | The `ADMIN_PASSWORD` from `.env`.                                                               |
| PIN      | 4–8 digits you choose. The sign-in screen shows digit boxes and signs you in on the last digit. |
| Passkey  | Add one or more passkeys, then sign in with a single tap. Needs HTTPS (or `localhost`).         |

The admin password **always** works as a fallback ("Use admin password instead" on the sign-in screen), so you can't lock yourself out. Changing `ADMIN_PASSWORD` and restarting signs out every device.

Failed attempts are rate-limited per IP address: after 5 wrong tries, each further mistake doubles the wait, up to an hour. PIN sign-in is also paused for an hour after 30 wrong PINs from any mix of addresses. The password keeps working while it's paused.

## Configuration (`.env`)

| Variable         | Default | What it does                                                                                                            |
| ---------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_PASSWORD` | —       | **Required.** The admin password.                                                                                       |
| `HOST_PORT`      | `8080`  | Port on the host (docker compose).                                                                                      |
| `PUBLIC_URL`     | —       | Public address, e.g. `https://files.example.com`. Used for copied links and passkeys. Blank = the address you're using. |
| `MAX_UPLOAD_MB`  | `500`   | Maximum size of one file.                                                                                               |
| `TRUST_PROXY`    | off     | Number of reverse proxies in front of Fyle (usually `1`). Needed for correct IPs and HTTPS detection.                   |
| `SESSION_DAYS`   | `30`    | How long a sign-in lasts. Activity extends it.                                                                          |
| `PUID` / `PGID`  | `1000`  | Owner of `./data` on the host.                                                                                          |

## Behind a reverse proxy / HTTPS

Passkeys and the clipboard button need HTTPS. Put Fyle behind your usual proxy and set `TRUST_PROXY=1` and `PUBLIC_URL`.

**Raise the proxy's upload limit**, or large files will fail:

- **Nginx / Nginx Proxy Manager:** `client_max_body_size 500m;` (default is 1 MB). Also consider `proxy_request_buffering off;` so uploads stream straight through.
- **Caddy:** no limit by default.
- **Traefik:** no limit by default (unless you added a buffering middleware).
- **Cloudflare (proxied / Tunnel):** the free plan caps uploads at **100 MB**. Upload bigger files over your LAN or a non-proxied hostname. Downloads aren't affected.

Example Caddyfile:

```
files.example.com {
  reverse_proxy fyle:3000
}
```

## Data & backups

Everything is in `./data`:

```
data/
├── fyle.json   # settings, passkeys, sessions, file list
└── files/      # the uploaded files
```

Back up that folder and you've backed up Fyle.

## Running without Docker

Needs Node.js 22 or newer.

```bash
npm ci --omit=dev
ADMIN_PASSWORD=... DATA_DIR=./data PORT=3000 npm start
```

## Credits

Type is [Inter](https://rsms.me/inter/) and [JetBrains Mono](https://www.jetbrains.com/lp/mono/) (SIL OFL), bundled with the app so it makes no third-party requests. Passkeys use [SimpleWebAuthn](https://simplewebauthn.dev/).
