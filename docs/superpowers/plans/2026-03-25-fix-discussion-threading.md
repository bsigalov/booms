# Fix Discussion Threading + Deployment Pipeline

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) Make discussion group updates appear as comments on the channel post. (2) Fix the deployment pipeline so container always picks up the latest image.

**Architecture:** Discussion threading: diagnostic logging → verify cross-chat reply → fallback to auto-forward detection. Deployment: use unique image tags (git SHA) instead of `:latest`, delete+recreate container to force fresh pull, add health check verification step.

**Tech Stack:** Node.js ESM, Telegram Bot API 7.0+, GitHub Actions, Azure CLI

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

### Task 4: Fix deployment pipeline

The current pipeline uses `:latest` tag which gets cached by Azure. The container often keeps running the old image after deploy. Fix: use git SHA as image tag, delete container before recreate, add verification step.

**Files:**
- Modify: `.github/workflows/deploy.yml`

- [ ] **Step 1: Use git SHA as image tag**

Replace the build step:
```yaml
      - name: Build image in ACR
        run: az acr build --registry orefbotacr --image oref-bot:${{ github.sha }} --image oref-bot:latest .
```

This builds with BOTH the SHA tag (unique, never cached) and `:latest` (for manual use).

- [ ] **Step 2: Delete container before recreate**

Add a delete step before the create step and use the SHA-tagged image:
```yaml
      - name: Delete old container
        env:
          STORAGE_KEY: ${{ secrets.AZURE_STORAGE_KEY }}
        run: az container delete --resource-group oref-bot-rg --name oref-bot --yes || true

      - name: Deploy container with persistent storage
        env:
          BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}
          STORAGE_KEY: ${{ secrets.AZURE_STORAGE_KEY }}
          ACR_PASS: ${{ secrets.ACR_PASSWORD }}
        run: |
          az container create \
            --resource-group oref-bot-rg \
            --name oref-bot \
            --image orefbotacr.azurecr.io/oref-bot:${{ github.sha }} \
            --registry-login-server orefbotacr.azurecr.io \
            --registry-username orefbotacr \
            --registry-password "$ACR_PASS" \
            --cpu 0.5 --memory 0.5 \
            --os-type Linux \
            --restart-policy Always \
            --environment-variables \
              TELEGRAM_BOT_TOKEN="$BOT_TOKEN" \
              TELEGRAM_CHAT_ID="$CHAT_ID" \
              TELEGRAM_CHANNEL_ID=@booms_on_the_way \
              TZ=Asia/Jerusalem \
            --azure-file-volume-account-name orefbotstorage \
            --azure-file-volume-account-key "$STORAGE_KEY" \
            --azure-file-volume-share-name oref-data \
            --azure-file-volume-mount-path /data
```

- [ ] **Step 3: Add health check verification**

Add a step that waits for the container to start and verifies it's running the new image:
```yaml
      - name: Verify deployment
        run: |
          echo "Waiting for container to start..."
          sleep 30
          STATE=$(az container show --resource-group oref-bot-rg --name oref-bot --query "containers[0].instanceView.currentState.state" -o tsv)
          IMAGE=$(az container show --resource-group oref-bot-rg --name oref-bot --query "containers[0].image" -o tsv)
          echo "State: $STATE"
          echo "Image: $IMAGE"
          if [ "$STATE" != "Running" ]; then
            echo "ERROR: Container is not running!"
            az container logs --resource-group oref-bot-rg --name oref-bot || true
            exit 1
          fi
          echo "Container running with image: $IMAGE"
```

- [ ] **Step 4: Verify syntax**

Check the YAML is valid by reviewing the file.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "fix: deployment uses SHA tags, delete+recreate, health check"
```

---

### Task 5: Deploy and verify everything

- [ ] **Step 1: Push all changes**

```bash
git push origin main
```

- [ ] **Step 2: Watch the deploy pipeline**

```bash
gh run watch
```

Verify:
- Build uses SHA tag
- Old container deleted
- New container created with SHA-tagged image
- Health check passes (state=Running, image contains SHA)

- [ ] **Step 3: Verify container is running new code**

```bash
az container logs --resource-group oref-bot-rg --name oref-bot | head -5
```

Expected: `Data directory: /data`, correct startup logs.

- [ ] **Step 4: Send /test or wait for real alert**

Check:
- Discussion updates appear as comments on channel post
- Logs show `[telegram] sendMessage → ... reply_to=XXX` or `[discussion] thread found: XXX`
- No more stale container issues

- [ ] **Step 5: If discussion threading still not working**

If the auto-forward message is NOT received via getUpdates:
- Check bot privacy mode: @BotFather → /setprivacy → Disable
- Check bot is admin in the discussion group with "read messages" permission
- Document findings and escalate to user
