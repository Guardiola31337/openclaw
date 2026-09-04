// Fixture snippet asserting opaque session isolation in the TUI PTY harness.
// Split out of tui-pty-harness-fixture-test-support.ts to keep it within the
// max-lines budget; injected into the fixture script by writeTuiPtyFixtureScript.
export function buildOpaqueSessionIsolationFixture(): string {
  return `
          if (opts.message.startsWith("opaque session isolation proof: ")) {
            const otherSessionKey = opts.sessionKey.includes(":matrix:")
              ? opts.sessionKey.replace("!MixedRoomAbCdEf", "!mixedroomabcdef")
              : opts.sessionKey.replace("AbC123=", "abc123=");
            const marker = "PTY_FOREIGN_OPAQUE_SESSION_MESSAGE";
            queueMicrotask(() => {
              record("foreignSessionEvent", { sessionKey: otherSessionKey, marker });
              this.onEvent?.({
                event: "chat",
                payload: {
                  runId: "run-foreign-opaque-session",
                  sessionKey: otherSessionKey,
                  state: "delta",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: marker }],
                  },
                },
              });
              this.onEvent?.({
                event: "session.message",
                payload: {
                  agentId: "main",
                  sessionKey: otherSessionKey,
                  sessionId: "foreign-opaque-session",
                  updatedAt: Date.now(),
                },
              });
            });
          }
  `;
}
