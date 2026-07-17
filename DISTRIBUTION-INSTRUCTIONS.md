# Distribution Instructions

This folder has two build paths:

- Windows users install the prebuilt `.exe`.
- macOS users build a `.dmg` through GitHub Actions or directly on a Mac.

## Files To Keep

Windows installer:

```text
apps/desktop/release/CardMirror Setup 0.1.0-beta.14.exe
```

Source package for GitHub/Mac builds:

```text
cardmirror-private-source.zip
```

The source package includes:

```text
.github/workflows/mac-desktop.yml
```

That workflow builds the macOS `.dmg` on GitHub's macOS runner and uploads it as
an artifact named `cardmirror-macos-dmg`.

## Upload To GitHub From Another Laptop

1. Sign into GitHub.
2. Create a new private repository, or fork `ant981228/cardmirror`.
3. Unzip `cardmirror-private-source.zip`.
4. Push the unzipped files to your repository.
5. Open the repository on GitHub.
6. Go to **Actions**.
7. Select **Build macOS Desktop**.
8. Click **Run workflow**.
9. When the run finishes, open the run and download the artifact named
   `cardmirror-macos-dmg`.

The artifact is a zip that contains the `.dmg`.

## Optional Relay Defaults

If you want the Mac app to open already pointed at your relay, add these
repository secrets before running the workflow:

```text
PAIRING_RELAY_URL
PAIRING_TOKEN
```

GitHub path:

```text
Settings -> Secrets and variables -> Actions -> New repository secret
```

If you do not set those secrets, the app still builds. Each user can enter the
relay manually in:

```text
Settings -> Collaboration
```

## Build Directly On A Mac Instead

On a Mac:

```sh
unzip cardmirror-private-source.zip
cd cardmirror-private-source
npm ci
npm --prefix apps/desktop ci
npm --prefix apps/desktop run dist
```

The `.dmg` will be in:

```text
apps/desktop/release/
```

To bake relay defaults into a direct Mac build:

```sh
export PAIRING_RELAY_URL="https://your-relay.example.com/relay"
export PAIRING_TOKEN="your-relay-token"
npm --prefix apps/desktop run dist
```

## Install Notes

Windows unsigned installer:

```text
More info -> Run anyway
```

macOS unsigned app:

```text
Right-click CardMirror -> Open -> Open
```

If macOS says the app is damaged:

```sh
sudo xattr -cr /Applications/CardMirror.app
```
