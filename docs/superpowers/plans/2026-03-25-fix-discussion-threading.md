# Fix Discussion Comments Threading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make discussion group updates appear as comments on the channel post, not standalone messages.

**Architecture:** Three-step approach: (1) Add diagnostic logging to understand what Telegram responds to our `reply_parameters`. (2) If cross-chat reply works, we're done. (3) If it doesn't, use a fallback: after sending a channel post, poll `getUpdates` with a dedicated call to find the auto-forwarded message's ID, then use `message_thread_id` for subsequent discussion messages.

**Tech Stack:** Node.js ESM, Telegram Bot API 7.0+

**Spec reference:** `docs/superpowers/specs/2026-03-24-booms-bot-spec.md` Section 3 (Discussion Group)

---

### Task 1: Add diagnostic logging for reply_parameters

Currently `sendTelegram` logs the message length and result, but doesn't log what `reply_parameters` is being sent. When the API rejects `reply_parameters`, it might return `ok: true` but silently ignore the reply, or return an error we're not seeing.

**Files:**
- Modify: `oref-alerts.mjs` — `sendTelegram()` function

- [ ] **Step 1: Log reply_parameters in sendMessage**

In `sendTelegram`, find the sendMessage log line:
```javascript
console.log(`[telegram] sendMessage → chat=${chatId} (${message.length} chars)`);
```

Replace with:
```javascript
const replyInfo = body.reply_parameters ? ` reply_to=${body.reply_parameters.message_id} in chat=${body.reply_parameters.chat_id || 'same'}` : '';
console.log(`[telegram] sendMessage → chat=${chatId} (${message.length} chars)${replyInfo}`);
```

Also log the full response body when `reply_parameters` was sent, to see if Telegram returns thread info:

After `if (result.ok)` line, add:
```javascript
if (result.ok && body.reply_parameters) {
  const r = result.result;
  console.log(`[telegram] reply result: msg_id=${r.message_id}, thread=${r.message_thread_id}, reply_to=${r.reply_to_message?.message_id}, chat=${r.chat?.id}`);
}
```

- [ ] **Step 2: Verify syntax**

Run: `node --check oref-alerts.mjs`

- [ ] **Step 3: Commit**

```bash
git add oref-alerts.mjs
git commit -m "debug: log reply_parameters in sendTelegram for discussion threading diagnosis"
```

---

### Task 2: Deploy and check logs after real alert

- [ ] **Step 1: Push and force recreate container**

```bash
git push origin main
# Wait for build
gh run list --limit 1 --json status,conclusion
# Force recreate
az container delete --resource-group oref-bot-rg --name oref-bot --yes
sleep 5
az container create ... (full command)
```

- [ ] **Step 2: Wait for real alert or send /test**

After the next alert, check logs:
```bash
az container logs --resource-group oref-bot-rg --name oref-bot | grep "reply"
```

Look for:
- `[telegram] sendMessage → chat=-1003793353562 ... reply_to=XXX in chat=@booms_on_the_way` — confirms reply_parameters is being sent
- `[telegram] reply result: ...` — shows what Telegram returned
- `[telegram] sendMessage FAILED: ...` — shows if Telegram rejected reply_parameters

- [ ] **Step 3: Analyze the result**

**If result shows `message_thread_id`** → cross-chat reply works! The messages should appear as comments. Check the channel to confirm.

**If result shows no `message_thread_id` and messages are still standalone** → cross-chat reply is silently ignored. Proceed to Task 3.

**If result shows FAILED** → cross-chat reply is rejected. Note the error. Proceed to Task 3.

---

### Task 3: Fallback — detect auto-forwarded message via dedicated getUpdates

If cross-chat reply doesn't work, we need the auto-forwarded message's ID in the discussion group. The previous attempts failed because `pollTelegramCommands` was consuming the updates before our detection code could see them.

**Fix:** Make a DEDICATED `getUpdates` call immediately after sending the channel post, BEFORE the regular polling loop can consume the update.

**Files:**
- Modify: `oref-alerts.mjs` — `updateEventMessage()` function

- [ ] **Step 1: Add thread detection after channel post**

In `updateEventMessage`, after `evt.lastTextMessageId = result.result.message_id;`, replace the boom button call with thread detection:

```javascript
    if (result?.ok) {
      evt.lastTextMessageId = result.result.message_id;

      // Detect the auto-forwarded discussion message
      if (!evt.isTest && TELEGRAM_DISCUSSION_ID) {
        // Wait for Telegram to create the auto-forward
        await new Promise(r => setTimeout(r, 2000));

        // Dedicated getUpdates call to catch the auto-forwarded message
        try {
          const updRes = await fetch(`${TELEGRAM_API}/getUpdates?offset=${lastUpdateId + 1}&timeout=3&allowed_updates=["message","channel_post"]`, {
            signal: AbortSignal.timeout(6000),
          });
          const updData = await updRes.json();
          if (updData.ok && updData.result) {
            for (const upd of updData.result) {
              lastUpdateId = upd.update_id; // consume so polling doesn't reprocess
              const m = upd.message;
              if (!m) continue;
              const cid = m.chat?.id?.toString();
              if (cid === TELEGRAM_DISCUSSION_ID) {
                // Any message from the discussion group right after our channel post
                // is likely the auto-forward. Use its message_thread_id or message_id.
                evt.discussionThreadId = m.message_thread_id || m.message_id;
                console.log(`[discussion] thread found: ${evt.discussionThreadId} (msg=${m.message_id}, is_auto_fwd=${m.is_automatic_forward}, sender=${m.sender_chat?.type})`);
                break;
              }
            }
          }
        } catch (e) {
          console.warn(`[discussion] thread detection failed: ${e.message}`);
        }
      }
    }
```

- [ ] **Step 2: Update sendDiscussionUpdate to use threadId when available**

In `sendDiscussionUpdate`, replace the reply_parameters approach with thread-based approach:

```javascript
  // Use discussion thread if detected, otherwise try cross-chat reply as fallback
  const opts = {};
  if (evt.discussionThreadId) {
    opts.threadId = evt.discussionThreadId;
  } else if (evt.lastTextMessageId) {
    opts.replyToMsgId = evt.lastTextMessageId;
    opts.replyChatId = TELEGRAM_CHANNEL_ID;
  }
  await sendTelegram(msg, TELEGRAM_DISCUSSION_ID, opts);

  // Boom button in the same thread
  if (BOOM_BUTTONS) {
    const boomOpts = {};
    if (evt.discussionThreadId) {
      boomOpts.threadId = evt.discussionThreadId;
    } else if (evt.lastTextMessageId) {
      boomOpts.replyToMsgId = evt.lastTextMessageId;
      boomOpts.replyChatId = TELEGRAM_CHANNEL_ID;
    }
    boomOpts.replyMarkup = BOOM_BUTTONS;
    await sendTelegram("💥 שמעתם בום? דווחו כאן:", TELEGRAM_DISCUSSION_ID, boomOpts);
  }
```

- [ ] **Step 3: Verify syntax**

Run: `node --check oref-alerts.mjs`

- [ ] **Step 4: Commit**

```bash
git add oref-alerts.mjs
git commit -m "fix: detect discussion thread via dedicated getUpdates after channel post"
```

---

### Task 4: Deploy and verify

- [ ] **Step 1: Push and force recreate container**

- [ ] **Step 2: Send /test or wait for real alert**

- [ ] **Step 3: Check discussion group**

Verify:
- Updates appear as **comments** on the channel post
- "Leave a Comment" on channel shows comment count
- Boom button appears in the thread
- Logs show `[discussion] thread found: XXX`

- [ ] **Step 4: If still not working**

If the auto-forward message is NOT received via getUpdates:
- The bot may not have the right permissions in the discussion group
- Check bot privacy mode: must be disabled (via @BotFather → /setprivacy → Disable)
- Or: the bot needs to be admin in the discussion group with explicit "read messages" permission
- Document findings and escalate to user
