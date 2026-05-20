# Releasing

## Branch strategy

- **`main`** — active development. PRs land here.
- **`production`** — release branch. Only stable, tagged commits live here.
- Tags `v*` are pushed **only from `production`**. The Release workflow triggers off the tag and produces installers.

## Quick release

From `main` (development):

```bash
git checkout production
git merge main          # or cherry-pick the commits you want to ship
```

Then bump versions and tag (still on `production`):

```bash
# Edit package.json (root) and apps/electron/package.json to the same new version (e.g. 0.8.13)
git add package.json apps/electron/package.json
git commit -m "Bump version to 0.8.13"
git tag v0.8.13
git push origin production --follow-tags
```

After the workflow finishes:

1. Open the GitHub Release draft and inspect the artifacts (DMG, ZIP, EXE, `latest*.yml`).
2. Click **Publish release** to flip from draft to public.

Installed apps auto-update through `electron-updater` because `electron-builder.yml` publishes to `provider: github` on this repo. As soon as a Release leaves draft state, every running install will pick up the update on the next check.

## Prerelease (rc)

To test a release without promoting it as latest:

```bash
git checkout production
# Edit to e.g. 0.8.13-rc.1
git add package.json apps/electron/package.json
git commit -m "Bump version to 0.8.13-rc.1"
git tag v0.8.13-rc.1
git push origin production --follow-tags
```

Tags containing `-rc` are uploaded as GitHub prereleases. `electron-updater` will not pick up prereleases by default — only the production build does, when the release is marked latest.

## Signing status

CI builds are currently unsigned. macOS Gatekeeper and Windows SmartScreen warnings are expected until signing is added.

Follow-up OpenSpec changes (planned, not implemented):

- `release-signing-macos`
- `release-signing-windows`

## Troubleshooting

To run the macOS CI build path locally:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false bun run electron:dist:mac
```

To delete a broken release:

```bash
gh release delete <tag>
git push origin :refs/tags/<tag>
```

To force the auto-update check from the app, open the menu → Check for updates.
