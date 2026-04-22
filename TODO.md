# TODO

Running list of deferred work and open questions. Add items here when they
come up in conversation but aren't the current focus. Delete or check off
once handled.

Format: `- [ ] <area>: <item> — <short why/context>`. Keep the why, drop
the item when done — git log is the history.

## Events / Automation

- [ ] `task.requested`: add optional `silent?: boolean` to the payload so
      headless callers (webhook scripts, monitoring) can opt out of the
      default `connectorCenter.notify`. Currently every task reply is
      pushed to the last-interacted connector, which is wrong for pure
      background jobs.
- [ ] `task-router`: support `sessionId` in the payload so different
      external callers get isolated conversation histories instead of
      sharing `task/default`.

## Security

- [ ] Broader API security audit. Only `/api/events/ingest` has auth
      today; the rest of `/api/*` (config mutation, cron CRUD, heartbeat
      trigger, chat, trading push, etc.) is unauthenticated and relies
      entirely on localhost binding. Needs a proper auth story (shared
      admin token? session cookies? per-route scopes?) before any of it
      is exposed beyond a single-user local machine.
- [ ] Webhook tokens: add admin UI for listing / adding / rotating
      tokens inside the Webhook tab instead of requiring hand-editing
      `data/config/webhook.json`. Config surface exists; just missing
      the form.
- [ ] Token scoping: a webhook token can currently fire any external
      event type. When more external types exist, let tokens declare
      which event types they're allowed to inject.

## Architecture

- [ ] Unified config hot-reload. Right now every consumer of a config
      section has to solve "did the user edit this?" on its own —
      Telegram/MCP-Ask via `reconnectConnectors`, opentypebb via lazy
      getters closing over `ctx.config` plus an `Object.assign` patch
      in the config PUT route, and anything holding a sub-reference
      (`const providers = ctx.config.marketData.providers` style) just
      goes stale. That's three different strategies living in one
      codebase, and the last patch (opentypebb lazy getters + ctx.config
      assign) is a band-aid that only works because `ctx.config`'s
      top-level object identity is preserved. What's missing: a single
      subscribe/publish surface over config sections (`configBus.on(
      'marketData', handler)` / `get('marketData')`) that writers hit
      once and consumers subscribe to, plus a file-watcher for the
      direct-edit case (people editing `data/config/*.json` in their
      editor bypass the PUT route entirely and still see stale behavior).
      Two-month-old config layer has been getting patched incrementally;
      worth doing one focused pass instead of another band-aid next time
      something goes stale.

## Bugs

- [ ] Snapshot / FX: after currency conversion, snapshot values
      occasionally come out as wildly wrong numbers (reported, cause
      unknown). Likely a direction mistake (multiply vs divide) or
      precision loss going through `number` instead of `Decimal`.
      Start: `src/domain/trading/snapshot/service.ts` (only file in
      snapshot/ that touches fx) + `src/domain/trading/fx-service.ts`.
      When next triggered, capture: (a) the raw `netLiquidation` /
      currency on the account, (b) the rate FxService returned, (c) the
      final displayed value — the TODO can't be narrowed without a
      concrete data point.

## (seed more areas as they come up)
