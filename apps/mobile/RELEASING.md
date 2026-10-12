# Releasing Ergates to TestFlight and Google Play

A release starts with a git tag that gflow sets. GitHub Actions then builds the app on GitHub-hosted runners, signs it, and uploads it to **TestFlight** (iOS) and the **Google Play internal testing track** (Android). Going public (App Store review, Play production) stays a manual step in App Store Connect and Play Console, described at the end.

The workflow is `.github/workflows/release.yml`; the build steps are scripts in `scripts/release/`, so you can run them on your Mac too. Store secrets live in two places only: the release folder on your Mac (`apps/mobile/.release/` by default; see Security notes for `ERGATES_RELEASE_DIR`), and the GitHub environment `app-stores`, which only release tags can use.

## How a release runs

| You run (gflow) | Branch | Tag | What happens |
|---|---|---|---|
| `gflow start release --minor` on `develop` | `release/X.Y.0` | `vX.Y.0-rc.1` | Build and upload; GitHub pre-release page |
| `gflow bump` on the release branch | same | `vX.Y.0-rc.N+1` | Build and upload; pre-release page |
| `gflow finish` on the release branch | lands on `master` and `develop` through PRs | `vX.Y.0` | Build and upload; release page |
| `gflow start hotfix-fix --name <n>` on `master`, then `gflow finish` | `hotfix/X.Y.Z` | `vX.Y.Z` | Build and upload; release page |

- **One version for the whole repo.** gflow runs `.gflow/set-version.sh X.Y.Z` when it starts a release or hotfix. On the release or hotfix branch the script writes the version into `app.json`, `package.json`, `package-lock.json` and the Hermes plugin (`pyproject.toml`, `plugin.yaml`, `ergates/__init__.py`, `dashboard/manifest.json`, `uv.lock`, and the `uv.lock` of the plugin's tests in `integrations/ergates-tests`), and gflow commits it as `chore: set version X.Y.Z`. On any other branch it changes nothing: `develop` keeps the last released version and gets the next one through gflow's release and hotfix merges, so those merges do not conflict on the version lines. (gflow also calls the script to move `develop` to the next minor; it then prints `↷ skipped: develop version bump (no changes)`.)
- **The tag gives the version.** `v0.3.0-rc.2` builds version `0.3.0`: Apple allows only digits and dots in the app version, so the `-rc.N` part stays in the tag. The run stops when `app.json` has another version than the tag.
- **Build number:** the workflow's run number plus the repository variable `BUILD_NUMBER_OFFSET` (default 0). iOS `CFBundleVersion` and Android `versionCode` get the same number, and it rises with every run.
- **Jobs:** `metadata` (version, channel, build number) → `checks` (the CI mobile job) → `build-android` and `build-ios` → `upload-android` and `upload-ios` → `github-release`. The `.aab` and `.ipa` stay downloadable on the run page for 14 days, by anyone, since the repository is public. They are store builds, signed for TestFlight and Play, not something you can install as-is.

## Costs

| Item | Cost |
|---|---|
| Apple Developer Program | 99 USD per year ([Apple](https://developer.apple.com/support/enrollment/)). Organizations also need a D-U-N-S number. |
| Google Play developer account | 25 USD, one time ([Google](https://support.google.com/googleplay/android-developer/answer/6112435)) |
| GitHub Actions | Free for a public repository, macOS runners included ([GitHub](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions)); at most 5 macOS jobs run at once ([GitHub](https://docs.github.com/en/actions/reference/limits)) |

## One-time setup

Do the steps in this order. Steps 2 and 3 put files and values in `apps/mobile/.release/`; make it first (to use a folder outside the repository instead, set `ERGATES_RELEASE_DIR` first and create that folder the same way — see Security notes):

```bash
cd apps/mobile
mkdir -m 700 .release
cp scripts/release/release.env.example .release/release.env
chmod 600 .release/release.env
```

### Step 1: GitHub

1. The repository, `github.com/middelkampdev/hermes-ergates`, already exists, is public, and its default branch is `develop`; gflow's mainline is `master`, and nobody pushes a `main` branch to it. It is MIT-licensed, with contributions under the repository's own license and no DCO; `apps/mobile/LICENSE` (the Expo template's) and the rest of the repository's license and community files land in a separate step, not this one.
2. Push `master`, land the current work on `develop`, and push `develop`. Run `git config gflow.branch.main master` in this checkout, and again right after any future clone of the repository: gflow otherwise tries `main` first when it picks the mainline branch.
3. In the repository settings, turn on **Automatically delete head branches**. gflow's landing branches, and its `release-fix/*` and `hotfix-fix/*` work branches, are never cleaned up otherwise.
4. Install `gh` and log in (`gh auth login`). gflow uses it to open pull requests.
5. Protect `master` and `develop` so that every change needs a pull request with green CI. Run this from the repository:

```bash
for branch in master develop; do
  gh api --method PUT "repos/{owner}/{repo}/branches/$branch/protection" --input - <<'JSON'
{
  "required_status_checks": { "strict": false, "contexts": ["workflow-lint", "mobile", "integration", "contract", "deploy"] },
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 0 },
  "restrictions": null
}
JSON
done
```

`.gflow/config` is committed with `mode=protected`: gflow opens a pull request for every landing and never merges one itself. Merge it on GitHub, then run the same gflow command again.

### Step 2: Apple

1. Join the Apple Developer Program. Copy your Team ID (developer.apple.com, Account, Membership details) into `APPLE_TEAM_ID`.
2. Register the bundle ID: Certificates, Identifiers & Profiles, Identifiers, the plus button, App IDs, explicit bundle ID `dev.middelkamp.ergates`.
3. Create the app record: App Store Connect, Apps, the plus button, New App. Choose iOS, the name Ergates, the bundle ID `dev.middelkamp.ergates`, and any unique SKU such as `ergates-ios`. Apple's API cannot create an app, so this step stays manual.
4. Create an App Store Connect API key: Users and Access, Integrations, App Store Connect API, Team Keys, the plus button. Give it the **App Manager** role. Apple lets the Developer role upload builds too ([Apple](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds)), but the upload action asks for App Manager ([upload-testflight-build](https://github.com/apple-actions/upload-testflight-build#getting-started)). Download the `.p8` file (Apple offers it **only once**) and save it as `.release/asc-api-key.p8`. Copy the Key ID into `APP_STORE_CONNECT_KEY_ID` and the Issuer ID above the key list into `APP_STORE_CONNECT_ISSUER_ID`.
5. Create the distribution certificate: in Keychain Access, Certificate Assistant, Request a Certificate From a Certificate Authority, saved to disk. Upload that request under Certificates, the plus button, **Apple Distribution**. Download the certificate and open it, so it lands in your login keychain with its private key. In Keychain Access, select the certificate and its key, Export, and save as `.release/ios-distribution.p12` with a password. Put that password in `IOS_DIST_CERT_PASSWORD`.
6. Create the provisioning profile: Profiles, the plus button, **App Store Connect**, the app ID `dev.middelkamp.ergates`, the certificate from step 5. Name it, for example `Ergates App Store`, download it and save it as `.release/ios-appstore.mobileprovision`.
7. In TestFlight, add yourself to an internal testing group. Internal testers are App Store Connect users (up to 100). Builds for external testers may need Beta App Review ([Apple](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview)).

The certificate and the profile show an expiry date in the portal. Before one expires, renew it, replace its file, and run step 4 again.

### Step 3: Google

1. Create a Google Play developer account. In Play Console, click **Create app**: name Ergates, app, free. Play Console is the only way to create it.
2. Accept **Play App Signing**: Google keeps the key that signs the app for users, and you sign each upload with your own upload key.
3. Create the service account key ([Expo guide](https://github.com/expo/fyi/blob/main/creating-google-service-account.md)):
   - In Google Cloud, enable the **Google Play Android Developer API**.
   - Create a service account, then a **JSON** key. Save it as `.release/play-service-account.json`.
   - In Play Console, Users and permissions, invite the service account email and give it the release permissions for Ergates.
4. Fill `ANDROID_UPLOAD_KEY_ALIAS`, `ANDROID_UPLOAD_KEYSTORE_PASSWORD` and `ANDROID_UPLOAD_KEY_PASSWORD` (the same value twice) in `release.env`, then create the upload keystore:

   ```bash
   scripts/release/make-upload-keystore.sh
   ```

   It writes `.release/android-upload.jks`. Back up the file and its password in your password manager: without it, a new upload key means a reset request to Google.
5. In Play Console, open Testing, Internal testing, and add your testers by email.
6. A Play app in draft status accepts only draft releases, so uploads are drafts until you set the repository variable `PLAY_RELEASE_STATUS` to `completed` (after the store listing and the setup tasks are done):

   ```bash
   gh variable set PLAY_RELEASE_STATUS --body completed
   ```

### Step 4: Upload the secrets

With the five files and `release.env` in `.release/`:

```bash
chmod 600 .release/*
scripts/release/upload-secrets.sh --check   # lists what is missing; uploads nothing
scripts/release/upload-secrets.sh
```

The helper creates or repairs the environment `app-stores` — it always writes the environment settings, so a copy set up by hand with the wrong deployment rule gets fixed too — with a deployment rule that allows only tags matching `v*`. It sets 11 environment secrets and the environment variable `APPLE_TEAM_ID` through `gh`, each value on stdin, and prints names only. Run it again after you replace a file.

### Step 5: The baseline tag

gflow starts a release from the newest clean tag, or from `0.0.0` when there is none. The Hermes plugin is already at `0.2.0`, so give gflow that starting point once, on the current `master` commit:

```bash
git switch master && git pull
git tag -a v0.2.0 -m "baseline: plugin 0.2.0 before the first gflow release"
git push origin v0.2.0
```

That commit has no `release.yml`, so this tag starts no release run.

### Step 6: The first release

```bash
git switch develop && git pull
gflow start release --minor
```

This cuts `release/0.3.0`, commits `chore: set version 0.3.0` there, and pushes the tag `v0.3.0-rc.1`; `develop` keeps its version until the release lands there. Then watch the run under Actions, **Release mobile**:

- [ ] `metadata` shows version `0.3.0`, channel `rc` and a build number.
- [ ] `checks`, `build-android` and `build-ios` are green, and the run page lists the artifacts `android-release` and `ios-release`.
- [ ] `upload-ios` is green, and the build shows in TestFlight after Apple's processing.
- [ ] `upload-android` is green, and the draft release shows in Play Console, Internal testing. If it fails with "Package not found", Play wants the first upload by hand: download `android-release`, upload `ergates.aab` in Play Console, Internal testing, Create new release, then start a manual run on the same tag (see below), which builds with a new build number.
- [ ] The GitHub Releases page shows `v0.3.0-rc.1` as a pre-release.

## Every release

- **Release candidate:** `gflow start release --minor` (or `--major`) on `develop`. Fixes go to the release branch through `gflow start release-fix --name <name>` and its pull request; `gflow bump` then tags the next RC.
- **Final release:** `gflow finish` on the release branch. It opens a pull request into `master`; merge it and run `gflow finish` again, which tags `vX.Y.0` and opens the pull request into `develop`; merge that and run it once more. gflow refuses to finish a release branch with commits after its last RC tag: run `gflow bump` first, so every commit on `master` was tested as an RC.
- **Hotfix:** `gflow start hotfix-fix --name <name>` on `master` creates `hotfix/X.Y.Z` with the version set, then `gflow finish`.
- **A hotfix while a release branch is open** also lands in that release branch, and there both sides changed the version lines, so gflow stops mid-merge and says where. In each conflict block of the eight version files (`package-lock.json` has two) keep the release branch's version, the higher one. Then `git add . && git commit --no-edit`, run `gflow finish` again, and `gflow bump` the release branch for a new RC. `master` and `develop` take the hotfix without a conflict.
- The same app (`dev.middelkamp.ergates`) gets every build, RC or final. TestFlight shows `0.3.0 (42)`: the version and the build number, and the build number leads back to the run and its tag.

## When a run fails

- **Fix forward.** A code problem gets a fix on the release branch and a new RC (`gflow bump`).
- **Apple emails a processing failure after the run is green:** the build never appears in TestFlight. `upload-ios` does not wait for Apple's processing, so a green run only means the upload succeeded, not that the build passed review. Fix it on the release branch and `gflow bump`; that build number is used up.
- **Run again on the same tag**, for example after a store or runner hiccup, or after the first manual Play upload. A manual run gets a new run number, so a new build number:

  ```bash
  gh workflow run release.yml --ref v0.3.0-rc.1
  gh workflow run release.yml --ref v0.3.0-rc.1 -f build-number=1234   # a build number of your choice
  ```

  A build number you choose must be higher than every build number already uploaded for this app in App Store Connect and in Play Console: neither store accepts a lower or reused number, and nothing here can check what the stores already have, so pick one safely above the last run's build number yourself.
- **Re-run failed jobs** in the Actions page keeps the run number and so the build number. That is fine when the store never accepted that number; when one store already has it, start a manual run instead.
- **The build refuses the provisioning profile.** `ios-signing` stops before Xcode archives anything when the App Store profile has no Name or UUID, belongs to a different team than `APPLE_TEAM_ID`, is issued for a different app ID, or is a development or ad hoc profile (`get-task-allow` true, or any devices listed). Fix or recreate the App Store profile (Step 2), replace `.release/ios-appstore.mobileprovision`, and upload the secrets again.
- **The metadata job says `app.json` has another version than the tag:** the tag's commit lacks gflow's `chore: set version` commit. Check `.gflow/set-version.sh` ran (gflow prints it) and cut a new RC.
- **Renaming `release.yml`** restarts the run numbers at 1. Raise the offset above the last build number first, for example `gh variable set BUILD_NUMBER_OFFSET --body 1000`.

## Tested Hermes range

The app offers one-tap setup of its server plugin only on a Hermes inside the range CI has tested. The oldest version is the `requires_hermes` floor in `integrations/ergates/plugin.yaml`. The newest is the minor in `expo.extra.hermesTestedThrough` in `apps/mobile/app.json`. `app.config.ts` copies both into the build as `extra.ergates`, next to the plugin's version, its API level and the commit of the checkout the build was made from.

Every Monday the `contract-latest` workflow runs the live contract tests against the newest stable Hermes. When they pass on a newer minor than `hermesTestedThrough`, the run opens the issue "Hermes vX.Y.Z passes the live contract tests: raise the tested range", once per release. Raise `hermesTestedThrough` to that minor in `apps/mobile/app.json` and ship it with the next release. Until you do, the app offers the manual guide instead of one-tap setup on that Hermes.

A Hermes pin bump that moves the `requires_hermes` floor past `hermesTestedThrough` needs the same change in the same pull request. The app config test fails there if it does not, and `app.config.ts` stops any build.

## Building on your Mac

The workflow runs `scripts/release/build-android.sh` and `scripts/release/build-ios.sh`; both run on a Mac with the same variables. iOS needs Xcode 26.4 or later and CocoaPods; Android needs Java 17 and the Android SDK (`ANDROID_HOME`). Each script regenerates its native folder with `expo prebuild --clean`, puts `app.json` back, and writes to `build/release/`.

```bash
cd apps/mobile
set -a && . .release/release.env && set +a
export BUILD_NUMBER=9000
export ANDROID_UPLOAD_KEYSTORE_BASE64="$(base64 < .release/android-upload.jks | tr -d '\n')"
scripts/release/build-android.sh
export IOS_DIST_CERT_P12_BASE64="$(base64 < .release/ios-distribution.p12 | tr -d '\n')"
export IOS_APPSTORE_PROFILE_BASE64="$(base64 < .release/ios-appstore.mobileprovision | tr -d '\n')"
scripts/release/build-ios.sh
```

`build-ios.sh` imports the certificate into a temporary keychain, adds it to your keychain search list next to the existing ones, and deletes it at the end, also after a failure. If a run was killed, `scripts/release/build-ios.sh --cleanup` removes it.

## Security notes

- Every store secret is an environment secret of `app-stores`. Only jobs that name the environment get them, and the environment accepts only runs on tags matching `v*`. Pull request runs, from forks too, never see them, and no workflow uses `pull_request_target`.
- Anyone who can push a tag can start a release. Keep write access to the repository to yourself.
- The release workflows pin every action to a full commit SHA, with the version in a comment.
- `upload-secrets.sh` refuses to run unless the release folder (`apps/mobile/.release/` by default, or the folder named by `ERGATES_RELEASE_DIR` when it is set, for example `~/.ergates-release`) is mode 700 and `release.env` and the five secret files are mode 600; it names the file to `chmod`. When the folder is inside this repository it must also be git-ignored: `upload-secrets.sh` refuses to run when git does not ignore it. A folder outside the repository (an `ERGATES_RELEASE_DIR` elsewhere) is never checked against git, since nothing outside the repository can be committed from here.
- Nothing prints a secret: every release script clears its own trace flag (`set +x`) before it runs, so invoking one with `bash -x`, or inheriting a caller's trace, cannot print a secret either. The build scripts decode keys into a temporary folder that they delete, and Gradle reads the Android passwords from the environment.
- To revoke access: revoke the API key in App Store Connect, revoke the certificate in the Apple Developer portal, delete the key in Google Cloud, and delete the environment `app-stores` on GitHub.

## Later: a public store release

This runbook stops at testing tracks. A public release also needs:

- A privacy policy URL, a store listing with screenshots, and the data-safety and content-rating forms. The privacy policy is https://middelkamp.dev/ergates/privacy/ and the support URL is https://middelkamp.dev/ergates/support/.
- A way for Apple's reviewers to use the app. Ergates needs a Hermes server, so reviewers need a demo server and login.
- On a Google **personal** account created after 13 November 2023: a closed test with at least 12 testers, opted in for 14 days in a row, before production access. Internal testing does not count ([Google](https://support.google.com/googleplay/android-developer/answer/14151465)).
- Two Play Console protections against tampered devices and copies (ADR-041). Both are set by hand in Play Console; nothing in the pipeline sets them:
  - [ ] Store listing visibility: turn on "Device integrity checks".
  - [ ] Automatic protection: turn on the "installer check". It needs Play App Signing and app bundles, which the pipeline already uses.
  - [ ] Check them on one internal testing track build: it installs from Play on a stock phone; a sideloaded copy of the same build prompts the user to get the app on Google Play; the crash rate in Play vitals stays flat for a week. Use the testing track, not internal app sharing: the installer check is not applied to internal app sharing uploads.

  "Device integrity checks" hides the app from phones that fail Google's device integrity check. That includes GrapheneOS and other custom systems. The app's own check stays on either way: it detects a rooted or jailbroken phone and keeps no sign-in on it (`src/state/device-trust.ts`).

Then submit the TestFlight build for review in App Store Connect, and promote the internal release to production in Play Console.

## After a public store release

The product page, privacy policy and support page live on the website https://middelkamp.dev, in its own repository (`~/Projects/mdev/website` on the owner's Mac). The website must match the app in the stores, so every public release ends with a website update. A final tag (`vX.Y.Z`) opens a GitHub issue "Update middelkamp.dev for vX.Y.Z" with this checklist.

When the version is live in both stores:

1. **Store links:** the App Store and Google Play links on `/ergates/` point to the live listings. Before the first release the page says "Coming to the App Store and Google Play".
2. **Screenshots:** still match the app. New ones come from the simulator; `public/assets/ergates/` holds them at 300 and 600 pixels wide.
3. **Privacy policy:** still true for this version. Check it whenever a release adds a permission, a push or notification service, analytics or crash reporting, or a new server the app talks to. If the text changes, update the date at the top of `/ergates/privacy/`.
4. **Support page:** still matches the connect and sign-out flow. It also says that rooted and jailbroken phones need a sign-in each time the app starts, and why (other apps with root access can read a stored sign-in), and that iOS may offer to save the password in its own Passwords app, which is the user's choice.
5. **Publish:** run `~/Projects/mdev/website/deploy.sh` (VPN on, Bitwarden unlocked), check https://middelkamp.dev/ergates/, and close the issue.

The website deploys over SSH from the owner's VPN address only, so GitHub Actions cannot publish it; the issue is the reminder.
