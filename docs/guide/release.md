# Release candidate checklist

The root `package.json` is the version source; this candidate is `1.0.0-rc.1`.
Desktop packaging injects that version into its bundled manifest. The macOS
plist version fields use the derived numeric release component (`1.0.0`); the
full candidate identity remains in the manifest and archive filename. Update it with
`npm version <next-version> --no-git-tag-version --ignore-scripts`, commit the
root manifest and lockfile, and update the changelog before the next candidate.
Do not maintain a separate desktop version.

## Prepared without owner credentials

The `mac-dev-package` job in **Desktop shell** installs locked tools, builds the
macOS `.app`, checks its actual daemon resources, runs the headless fixture
journey through that app and uploads:

- `macOS-development-app`: a `Massion-<version>-macOS-<arch>-unsigned.zip` archive.
  The runner architecture appears in its filename; this is not a universal app.
- `macOS-install-smoke-evidence`: screenshot, accessibility snapshot, app/daemon
  logs and `report.json` identifying the version and tested journey.

The archive retains symlinks and executable modes. Extract with
`ditto -x -k <archive.zip> <empty-directory>`. This is an unsigned development
artifact, not a public installer. Node 24.19+ in the 24.x line and SurrealDB 3.3.0
remain separate prerequisites. Packaging does not install either or configure a
provider. CI never signs with Developer ID, notarizes, creates tags or publishes.

## Owner-only distribution steps

Run these only after reviewing the final merged commit and green checks. They
require the owner's Apple Developer membership, Developer ID Application
certificate and private key, Xcode command-line tools, notarization access, and
GitHub release permission. Keep credentials out of source, arguments and logs.
These commands are a checklist, not steps executed by this PR.

- [ ] Select the exact reviewed commit on `main` in a clean checkout. Install
  Node 24 and the locked root/desktop tools. Inspect `CHANGELOG.md`, the matching
  CI head SHA and all checks, including durable restore, browser journeys and
  macOS install smoke. Record the SHA before producing distribution bytes.

  ```sh
  git switch main
  git pull --ff-only origin main
  git status --short
  release_commit=$(git rev-parse HEAD)
  version=$(node -p "require('./package.json').version")
  arch=$(uname -m)
  npm ci --ignore-scripts --no-audit --no-fund
  npm ci --prefix desktop --ignore-scripts --no-audit --no-fund
  npm run build --prefix desktop
  ```

  Produces a clean, pinned source/build selection. Stop if the worktree is dirty
  or the recorded commit is not the reviewed green head. The unsigned CI zip is
  evidence for that commit; the signed build below is a new artifact.

- [ ] Select the installed Developer ID Application identity. This checklist uses
  the pinned **electron-builder 26.18.0** options; v27 signing options differ.

  ```sh
  security find-identity -v -p codesigning
  printf 'Developer ID Application identity: '
  read -r signing_identity
  (
    cd desktop
    ./node_modules/.bin/electron-builder --config electron-builder.cjs \
      --mac dir --publish never \
      --config.mac.identity="$signing_identity" \
      --config.mac.hardenedRuntime=true --config.mac.notarize=false \
      --config.forceCodeSigning=true
  )
  app=$(find desktop/release -maxdepth 2 -name Massion.app -type d -print -quit)
  test -n "$app"
  codesign --verify --deep --strict --verbose=2 "$app"
  codesign --display --verbose=4 "$app"
  node desktop/tests/check-package.mjs
  npm run smoke:install --prefix desktop
  ```

  Produces a nested, Developer ID-signed app with hardened runtime and fuses
  applied before signing. Check the displayed identity/TeamIdentifier and runtime
  flag. Stop on missing identity, ad-hoc fallback or failed verification. No
  notarization or publication occurs in this command. Do not edit the bundle
  after signing. Retest each architecture you intend to ship separately.

- [ ] Store notarization credentials interactively in the owner's Keychain once.

  ```sh
  xcrun notarytool store-credentials massion-notary
  ```

  Produces the `massion-notary` Keychain profile after credential validation. Follow
  its prompts; do not paste credentials into shell history or this repository.

- [ ] Submit the signed bundle, wait for **Accepted**, and retain its submission
  ID. Investigate any rejection using `notarytool log`; do not ship it.

  ```sh
  mkdir -p .runtime/release
  submission=".runtime/release/Massion-${version}-${arch}-submission.zip"
  ditto -c -k --sequesterRsrc --keepParent "$app" "$submission"
  xcrun notarytool submit "$submission" --keychain-profile massion-notary --wait
  # If rejected, use the ID printed above:
  # xcrun notarytool log <submission-id> --keychain-profile massion-notary .runtime/release/notary-log.json
  ```

  Produces an Apple notarization submission and its result. The submission zip
  does not yet contain a stapled ticket.

- [ ] Attach the ticket and validate the final app, then archive those exact bytes.

  ```sh
  xcrun stapler staple "$app"
  xcrun stapler validate "$app"
  codesign --verify --deep --strict --verbose=2 "$app"
  spctl --assess --type execute --verbose=4 "$app"
  archive=".runtime/release/Massion-${version}-macOS-${arch}.zip"
  ditto -c -k --sequesterRsrc --keepParent "$app" "$archive"
  (cd .runtime/release && shasum -a 256 "Massion-${version}-macOS-${arch}.zip" > "Massion-${version}-macOS-${arch}.zip.sha256")
  ```

  Produces the stapled app, Gatekeeper assessment, final distribution zip and
  SHA-256. Retain the reports. Confirm extraction and launch on a separate clean
  test Mac, including first-run prerequisites and retained data after restart.
  The fixture smoke does not prove Gatekeeper or installed-provider behavior.

- [ ] Recheck the source SHA and create the candidate tag explicitly.

  ```sh
  test "$(git rev-parse HEAD)" = "$release_commit"
  test -z "$(git status --porcelain)"
  git tag -a "v$version" "$release_commit" -m "Massion $version"
  git push origin "refs/tags/v$version"
  ```

  Produces the annotated tag and pushes only that tag. Stop if the tag exists;
  do not move it or force-push. Use a new candidate version for changed bytes.

- [ ] Create and review a draft GitHub prerelease with the signed, notarized
  archive and checksum. Use the changelog for its English notes.

  ```sh
  gh release create "v$version" --repo jabdori/massion --verify-tag \
    --title "Massion $version" --prerelease --draft \
    --notes-file CHANGELOG.md "$archive" "$archive.sha256"
  gh release view "v$version" --repo jabdori/massion
  # Only after reviewing the draft assets and notes:
  gh release edit "v$version" --repo jabdori/massion --draft=false
  ```

  Produces a draft, then an explicitly published **prerelease**. Do not label an
  RC as stable 1.0. A stable release needs a new reviewed version and the same
  signing, notarization and verification gates. No npm publication, auto-update
  channel or bundled prerequisite installer is prepared here.

See Apple's [Developer ID](https://developer.apple.com/developer-id/) and
[custom notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow),
Electron's [signing guide](https://www.electronjs.org/docs/latest/tutorial/code-signing),
and the [electron-builder v26 macOS options](https://www.electron.build/v26/docs/mac/).
