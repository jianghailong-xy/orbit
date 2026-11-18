---
title: Connect Feishu or Lark
summary: Use a Feishu or Lark app of your own as Orbit's bot, for alerts and for giving agents work from a chat.
category: integrations-and-api
routes: [/settings/integrations/feishu, /settings/integrations/feishu/connect-group, /admin/integrations]
errors: []
platforms: [web]
common: false
updated: 2026-11-14
---

You can connect a Feishu or Lark app of your own to Orbit as its bot. Orbit opens a long connection to Feishu itself, so your Orbit server needs no public address.

Your alerts, such as approvals and finished sessions, then reach you in a direct message from the bot. In a group you have connected, @mention the bot to hand it work.

## Before you start

Feishu bots are on by default. If [Settings → Feishu](orbit:/settings/integrations/feishu) says "An administrator has turned off Feishu bots on this Orbit server.", ask an administrator to turn on **Admin → Integrations → Allow accounts to connect Feishu bots**.

## Set up the app in Feishu

[Settings → Feishu](orbit:/settings/integrations/feishu) walks you through it under **Set up the app in Feishu**:

1. **Create a custom app** in the Feishu or Lark developer console and add the Bot feature. In a company workspace, publishing usually needs an administrator's approval.
2. **Grant it these permissions**: copy each one from the list on the page. Do not grant reading every group message: only messages that @mention the bot reach Orbit.
3. **Enter its App ID and App Secret in Orbit first**: paste them into **Your app** and press **Connect**. Wait until Orbit shows the app as connected. The secret is never shown again.
4. **Switch to the long connection**: in the console, receive events and callbacks through the long connection, and subscribe to the events listed on the page. The console only saves this once Orbit is connected, which is why step 3 comes first.
5. **Publish it**: choose who can use the app (at least you, and the members of any group you will use) and publish a version.

## Connect your Feishu account

Under **Your Feishu account**, press **Connect your Feishu account**. Send the code shown to the bot in a direct message, not in a group. The code works once, for a limited time. The card then says **Connected**.

## Groups

Add the bot to a group. It replies with a card; open it to connect the group in Orbit. Connected groups are listed under **Groups**.

## Removing it

**Remove app** on the page disconnects the bot from Orbit.

Full guide: [Feishu bot design](../../feishu-bot-design.md).
