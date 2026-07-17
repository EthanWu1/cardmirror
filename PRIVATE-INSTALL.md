# Private Install Guide

This is the practical path for installing this fork for you and one other person.
Both people need the same app build and must use the same relay.

## Recommended Setup

Use the desktop app for both people and run one self-hosted relay.

- The desktop app gives the best file access and enables collaboration settings.
- The relay must be reachable by both machines.
- Persistent shared `.cmir` files require the relay from this fork, not an older
  upstream relay that lacks `/relay/docs`.

## 1. Run The Relay

For a local or VPS Docker install:

```sh
cd relay
RELAY_TOKEN=$(openssl rand -hex 24) docker compose up -d
```

On Windows PowerShell:

```powershell
cd relay
$env:RELAY_TOKEN = -join ((48..57 + 97..102) | Get-Random -Count 48 | ForEach-Object {[char]$_})
docker compose up -d
```

Check it:

```sh
curl http://localhost:8410/relay/health
```

Expected response:

```json
{"ok":true}
```

For two people on different networks, put the relay behind HTTPS and use a URL
like:

```text
https://relay.example.com/relay
```

For two people on the same LAN, a temporary test can use:

```text
http://<your-computer-lan-ip>:8410/relay
```

## 2. Choose How To Configure The App

### Option A: Manual Settings

Build or install the app, then on both machines open:

```text
Settings -> Collaboration
```

Set:

```text
Custom relay URL   = https://relay.example.com/relay
Custom relay token = the RELAY_TOKEN from step 1
```

This is easiest for testing because you do not need a custom installer.

### Option B: Private Installer With Relay Defaults Baked In

This is cleaner for handing the app to someone else. The installer opens already
pointed at your relay.

Set the relay defaults before building:

PowerShell:

```powershell
$env:PAIRING_RELAY_URL = "https://relay.example.com/relay"
$env:PAIRING_TOKEN = "<same token as RELAY_TOKEN>"
npm run desktop:dist
```

macOS/Linux shell:

```sh
PAIRING_RELAY_URL="https://relay.example.com/relay" \
PAIRING_TOKEN="<same token as RELAY_TOKEN>" \
npm run desktop:dist
```

The generated installers land under:

```text
apps/desktop/release/
```

Build on the same OS you want to distribute. A Windows machine builds the
Windows installer; a Mac builds the `.dmg`; Linux builds the AppImage/pacman
package.

## 3. Install On Both Machines

Give the other person the installer from `apps/desktop/release/`.

Windows unsigned build:

```text
More info -> Run anyway
```

macOS unsigned build:

```text
Right-click CardMirror -> Open -> Open
```

If macOS says the app is damaged:

```sh
sudo xattr -cr /Applications/CardMirror.app
```

## 4. Use A Shared Document

1. One person opens or creates a `.cmir`.
2. Start a collaboration session.
3. Save the document as a shared `.cmir`.
4. Put that `.cmir` in Dropbox/Drive/email/USB, or send it directly.
5. The other person opens the same `.cmir`; it reconnects to the relay-backed
   shared document.

Anyone who has the shared `.cmir` plus relay access can edit it. This fork does
not yet have read-only links, roles, per-user revocation, or audit logs.

## Operational Notes

- Keep one relay worker process. The relay push registry is in process.
- Back up the relay Postgres volume if the document matters.
- Do not rotate `RELAY_TOKEN` unless you are ready to update both installs or
  both users' settings.
- If the relay is down, shared `.cmir` files open as local copies and can retry
  later.
- To end a persistent shared document, use the app's end-session flow or the
  relay management endpoint:

```sh
curl -X DELETE \
  -H "Authorization: Bearer <RELAY_TOKEN>" \
  https://relay.example.com/relay/docs/<docId>
```
