# Releasing

## Quick release

1. Run `npm version patch` from the repository root. Use `minor` or `major` when the release scope requires it.
2. Confirm the version is aligned in both `package.json` and `apps/electron/package.json`.
3. Push the release commit and tag with `git push --follow-tags`.
4. Wait for the tag-triggered Release workflow to finish.
5. Review the GitHub Release draft and attached artifacts.
6. Click "Publish release" in GitHub when the draft is correct.

## Prerelease (rc)

Use an rc version to test the workflow without publishing a final release:

```bash
npm version 0.8.13-rc.1
git push --follow-tags
```

Tags containing `-rc` are uploaded as GitHub prereleases.

## Signing status

Current CI release builds are unsigned. macOS Gatekeeper and Windows SmartScreen warnings are expected until signing is added.

Follow-up OpenSpec changes:

- `release-signing-macos`
- `release-signing-windows`

## Troubleshooting

To run the macOS CI build path locally:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false bun run electron:dist:mac
```

To delete a broken release draft:

```bash
gh release delete <tag>
```
