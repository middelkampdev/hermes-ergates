# Ergates: notes for AI agents

## The website follows the app

The app's product page, privacy policy and support page live on
https://middelkamp.dev, in a separate repository (`~/Projects/mdev/website`
on the owner's Mac, published with its `deploy.sh`). They must match what the
app in the stores does.

- **After a public store release** (a final `vX.Y.Z` that is live in the App
  Store and Google Play): update and publish the website. The checklist is in
  `apps/mobile/RELEASING.md`, section "After a public store release". The
  release workflow also opens a GitHub issue "Update middelkamp.dev for
  vX.Y.Z" with the same checklist.
- **When a change alters what data the app handles** (a new permission, a push
  or notification service, analytics or crash reporting, a new server the app
  talks to, or what it stores on the phone): say in your report that the
  privacy policy at `public/ergates/privacy/index.html` in the website
  repository needs the same change before that version ships.
- The website deploys over SSH from the owner's VPN address only. Prepare the
  change and tell the owner; publishing needs their machine.
