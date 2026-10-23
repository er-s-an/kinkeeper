// Thin MCP client wrapper used by the orchestrator (the simulated Alexa+
// companion) to reach the self-hosted KinKeeper MCP server over Streamable
// HTTP. All agent -> capability traffic goes through this protocol client.
//
// Retry contract: after a transport/generic error a call is retried ONCE
// (after reconnect) only when repeating it cannot create duplicates — either
// the tool is truly side-effect-free, or the arguments carry a stable
// idempotency key (`idempotency_key` / `dedupe_key`) that the server
// deduplicates on. Mutating calls without a key fail honestly instead of
// being re-sent.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Truly side-effect-free reads. get_weekly_digest and assess_risk COMPUTE
// from read-only data but each call appends an audit event to the store
// (`digest_generated` / `risk_assessed`), so they are NOT safe to auto-retry:
// a resent call whose first attempt actually reached the server would record
// the event twice. They must carry a key or fail honestly like mutations.
const READ_ONLY_TOOLS = new Set(['get_care_journal']);

export function isSafeToRetry(name, args) {
  return (
    READ_ONLY_TOOLS.has(name) ||
    Boolean(args?.idempotency_key) ||
    Boolean(args?.dedupe_key)
  );
}

export function createMcpClientPool({ serverUrl, onEvent }) {
  let client = null;
  let connecting = null;

  async function connect() {
    const c = new Client(
      { name: 'kinkeeper-companion-orchestrator', version: '0.1.0' },
      { capabilities: {} }
    );
    const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
    await c.connect(transport);
    onEvent?.({
      type: 'mcp_connected',
      protocolVersion: c.protocolVersion ?? null,
      serverInfo: c.getServerVersion?.() ?? null,
    });
    return c;
  }

  async function getClient() {
    if (client) return client;
    if (!connecting) {
      connecting = connect()
        .then((c) => {
          client = c;
          return c;
        })
        .finally(() => {
          connecting = null;
        });
    }
    return connecting;
  }

  return {
    async callTool(name, args) {
      let c = await getClient();
      try {
        return await c.callTool({ name, arguments: args });
      } catch (err) {
        if (!isSafeToRetry(name, args)) {
          // Never blindly re-send a mutation: without an idempotency key a
          // retry could double-record a check-in or duplicate an inbox card.
          throw new Error(
            `MCP tool call "${name}" failed and was NOT retried (mutating call without an idempotency key): ${err?.message || err}`
          );
        }
        // Safe to repeat: reconnect once, then resend with the same key.
        try {
          await client?.close();
        } catch {}
        client = null;
        c = await getClient();
        return c.callTool({ name, arguments: args });
      }
    },
    async listTools() {
      const c = await getClient();
      return c.listTools();
    },
    async protocolVersion() {
      const c = await getClient();
      return c.protocolVersion ?? null;
    },
    async close() {
      try {
        await client?.close();
      } catch {}
      client = null;
    },
  };
}
