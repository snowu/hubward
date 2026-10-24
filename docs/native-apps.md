# Native apps for Android and iPhone

What it would take to ship Hubward as a store app, written 2026-10-24.
Nothing here is planned; it complements `docs/scaling.md`, and several items
depend on the custom domain proposed there.

Short answer: for a single-purpose transit page the installed PWA already
gets most of the way, especially on Android. Native is only worth it for the
few things the web cannot do (widgets, lock-screen countdowns, background
location).

## Option 0: stay a PWA (what we have)

- **Android:** close to native already. It installs, gets push and opens
  standalone.
- **iPhone:** works, with caveats. Web Push only works once the page has been
  added to the home screen (iOS 16.4+), and there is no install prompt:
  people have to find Share → Add to Home Screen themselves.
- **Neither** gets home-screen widgets, lock-screen countdowns or background
  location. The last one is why radius-limited alerts measure from "where you
  last opened the app" (`LOCATION_FRESH`).

## Option 1: Android Play Store via TWA

A Trusted Web Activity is the PWA in a Play Store wrapper. Bubblewrap or
PWABuilder generates it; there is no new app code.

- **Domain:** Digital Asset Links require
  `/.well-known/assetlinks.json` at the **origin root**. That is awkward on
  `snowu.github.io/hubward`: one more reason for a custom domain.
- **Play account:** $25 once. New personal accounts must run a closed test
  with 12 testers for 14 days before publishing.
- **What it buys:** a store listing, and little else. Every deploy of `web/`
  still reaches the app immediately.

## Option 2: Capacitor, both stores, same code

Capacitor wraps `web/` in a native shell. Most of `app.js` runs unchanged,
but several pieces change:

- **Origin.** The page loads from `capacitor://localhost` (iOS) or
  `https://localhost` (Android). `ALLOWED_ORIGIN`, CORS and the `Origin`
  check in `src/live.js` must accept it.
- **Push.** Web Push becomes native push (APNs, FCM). `sendPush` in
  `src/push.js` needs a second delivery path, and tracking must store native
  device tokens beside web subscriptions.
- **Sign-in.** A magic link opens the browser, not the app. Either universal
  links / app links, or a 6-digit email code (Supabase supports email OTP).
- **Updates.** Web files ship inside the bundle, so changes go through store
  review. Live-update services (Capgo, Appflow) work around that.
- **App Store review.** $99 a year, and guideline 4.2 rejects apps that are
  just a website in a wrapper. It needs real native features to pass — see
  below.
- **Account deletion.** Apple requires it in-app; it overlaps with the GDPR
  item in `docs/scaling.md`.

## What native actually buys

1. **Home-screen widgets** — where this project started. Native code even
   with Capacitor: Glance/AppWidget in Kotlin, WidgetKit in Swift. Each reads
   `/arrivals` for a couple of saved stops.
2. **iOS Live Activities / Dynamic Island.** A live "the 27 in 4 min" on the
   lock screen while walking to the stop: a perfect fit, impossible on the
   web. The worker would send ActivityKit push updates instead of web push.
3. **Background location.** Radius watches and the "leave now" alerts in
   `docs/todo.md` would work while the app is closed.

## Option 3: full native, React Native or Flutter

A rewrite of ~5.7k lines of `app.js` plus the map. Only worth it if the
native features above become the product, and even then Capacitor with
native widget and Live Activity extensions gets ~90% of the way for far less.

## Recommendation

Stay a PWA. For a store presence, do the Android TWA after the custom
domain: nearly free. Go to iOS only if Live Activities or widgets become
something actually wanted — that means Capacitor plus a small Swift
extension, native push in the worker, and code-based sign-in.
