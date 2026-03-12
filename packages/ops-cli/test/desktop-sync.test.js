import test from "node:test";
import assert from "node:assert/strict";

import { DesktopSyncWorkaround } from "../src/desktop-sync.js";

test("desktop sync no-ops on non-darwin without custom command", async () => {
  const sync = new DesktopSyncWorkaround({
    platform: "linux",
    debounceMs: 5,
  });

  sync.schedule({ threadId: "t-1", reason: "test" });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(sync.timers.size, 0);
  sync.stop();
});

test("desktop sync schedules timers for darwin", async () => {
  const sync = new DesktopSyncWorkaround({
    platform: "darwin",
    debounceMs: 10,
    commandTemplate: "true",
  });

  sync.schedule({ threadId: "t-1", reason: "test" });
  assert.equal(sync.timers.size, 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sync.timers.size, 0);
  sync.stop();
});

