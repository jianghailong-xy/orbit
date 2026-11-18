---
title: Users and sign-in
summary: Add accounts, reset passwords, make administrators, and turn on Google sign-in.
category: admin-and-self-hosting
routes: [/admin, /admin/sign-in, /setup, /login]
errors: []
platforms: [web]
common: false
updated: 2026-11-14
---

Administrators manage who can use this Orbit server. Admin is in the account menu, and only administrators see it.

## The first administrator

On a new server, every address leads to `/setup`. Whoever creates the first account there is the administrator. There is no public sign-up after that.

## Add a user

1. Open [Admin](orbit:/admin). The **Users** page lists every account.
2. Press **Add user**, enter the **Email** and, optionally, a **Name (optional)**.
3. Press **Create**. A one-time password is generated and shown once: give it to the person privately.

With Google sign-in on, tick **Google sign-in only** to create an account that has no password and signs in with Google.

## Manage an account

Each account's ⋯ menu offers **Reset password**, **Make admin** (or **Make member**), **Disable**, and **Send welcome email** when email is set up. Disabling asks you first and says what stops.

## Google sign-in

1. Open [Admin → Sign-in](orbit:/admin/sign-in) and copy the **Authorized redirect URI**.
2. In the Google Cloud console, create an OAuth client of the **Web application** type and add that redirect URI exactly.
3. Back in Orbit, turn on **Allow signing in with Google**, paste the **Client ID** and **Client secret**, and choose **Who can sign in with Google**: **Existing accounts only** or **Anyone with a Google account**.
4. Press **Save**.

The login page then offers **Continue with Google**, on the web and in the apps. A password always keeps working.

Google needs an `https` address on a public domain name; `http://localhost` is the one exception.

Full guide: [Self-hosting: Google sign-in](../../self-hosting.md#google-sign-in).
