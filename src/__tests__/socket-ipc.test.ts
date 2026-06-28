import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SocketServer } from "../events/socket-server";
import { SocketClient } from "../events/socket-client";
import type { SocketMessage } from "../events/socket-server";

const getUnusedPort = (): number => {
  // Use a port range unlikely to conflict
  return 12000 + Math.floor(Math.random() * 5000);
};

/**
 * Socket IPC Tests
 *
 * Verifies TCP communication between scheduler (server) and agents (clients).
 * Tests the full message protocol: register, heartbeat, task_done, task_failed.
 */
describe("SocketServer", () => {
  let server: SocketServer;
  let port: number;

  beforeEach(async () => {
    port = getUnusedPort();
    server = new SocketServer(port);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("starts and listens on the given port", () => {
    expect(server.agentCount).toBe(0);
    expect(server.getConnectedAgents()).toHaveLength(0);
  });

  it("rejects on port already in use", async () => {
    const server2 = new SocketServer(port);
    await expect(server2.start()).rejects.toThrow("already in use");
  });

  it("broadcasts messages to all connected agents", async () => {
    const client1 = new SocketClient("agent-A", port);
    const client2 = new SocketClient("agent-B", port);

    const msg1Spy = new Promise<SocketMessage>((resolve) => {
      client1.on("warning", resolve);
    });
    const msg2Spy = new Promise<SocketMessage>((resolve) => {
      client2.on("warning", resolve);
    });

    await client1.connect();
    await client2.connect();

    // Small delay to ensure registration completes
    await new Promise((r) => setTimeout(r, 50));

    server.broadcast({ type: "warning", message: "all hands!" });

    const msg1 = await Promise.race([msg1Spy, timeout(1000)]);
    expect(msg1.type).toBe("warning");

    client1.disconnect();
    client2.disconnect();
  });

  it("isConnected returns true for connected agents", async () => {
    const client = new SocketClient("agent-conn", port);

    await client.connect();
    await new Promise((r) => setTimeout(r, 50));

    expect(server.isConnected("agent-conn")).toBe(true);
    expect(server.isConnected("no-such-agent")).toBe(false);

    client.disconnect();
  });

  it("pings an agent", async () => {
    const client = new SocketClient("agent-ping", port);

    const pingReceived = new Promise<void>((resolve) => {
      client.on("ping", () => resolve());
    });

    await client.connect();
    await new Promise((r) => setTimeout(r, 50));

    const sent = server.pingAgent("agent-ping");
    expect(sent).toBe(true);

    await Promise.race([pingReceived, timeout(1000)]);

    client.disconnect();
  });
});

describe("SocketClient", () => {
  let server: SocketServer;
  let port: number;

  beforeEach(async () => {
    port = getUnusedPort();
    server = new SocketServer(port);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("connects and registers with server", async () => {
    const client = new SocketClient("agent-1", port);

    const connectedPromise = new Promise<void>((resolve) => {
      server.once("agent_connected", (agentId: string) => {
        expect(agentId).toBe("agent-1");
        resolve();
      });
    });

    await client.connect();
    await Promise.race([connectedPromise, timeout(2000)]);

    expect(client.isConnected).toBe(true);
    expect(server.isConnected("agent-1")).toBe(true);

    client.disconnect();
  });

  it("sends heartbeat messages", async () => {
    const client = new SocketClient("agent-hb", port);

    const hbReceived = new Promise<void>((resolve) => {
      server.on("heartbeat_received", (agentId: string, locks: string[]) => {
        expect(agentId).toBe("agent-hb");
        expect(locks).toEqual(["src/a.ts", "src/b.ts"]);
        resolve();
      });
    });

    await client.connect();
    await new Promise((r) => setTimeout(r, 50));

    client.sendHeartbeat(["src/a.ts", "src/b.ts"]);

    await Promise.race([hbReceived, timeout(2000)]);

    client.disconnect();
  });

  it("notifies task done", async () => {
    const client = new SocketClient("agent-done", port);

    const doneReceived = new Promise<void>((resolve) => {
      server.on("task_completed", (agentId: string, taskId: string) => {
        expect(agentId).toBe("agent-done");
        expect(taskId).toBe("task-uuid-123");
        resolve();
      });
    });

    await client.connect();
    await new Promise((r) => setTimeout(r, 50));

    client.notifyTaskDone("task-uuid-123");

    await Promise.race([doneReceived, timeout(2000)]);

    client.disconnect();
  });

  it("notifies task failed with reason", async () => {
    const client = new SocketClient("agent-fail", port);

    const failReceived = new Promise<void>((resolve) => {
      server.on("task_failed", (agentId: string, taskId: string, reason: string) => {
        expect(agentId).toBe("agent-fail");
        expect(taskId).toBe("task-bad");
        expect(reason).toBe("compilation error");
        resolve();
      });
    });

    await client.connect();
    await new Promise((r) => setTimeout(r, 50));

    client.notifyTaskFailed("task-bad", "compilation error");

    await Promise.race([failReceived, timeout(2000)]);

    client.disconnect();
  });

  it("server detects client disconnect", async () => {
    const client = new SocketClient("agent-dis", port);

    const disconnectPromise = new Promise<void>((resolve) => {
      server.once("agent_disconnected", (agentId: string) => {
        expect(agentId).toBe("agent-dis");
        resolve();
      });
    });

    await client.connect();
    await new Promise((r) => setTimeout(r, 50));

    expect(server.isConnected("agent-dis")).toBe(true);

    client.disconnect();

    await Promise.race([disconnectPromise, timeout(2000)]);
    expect(server.isConnected("agent-dis")).toBe(false);
  });

  it("handles multiple clients simultaneously", async () => {
    const client1 = new SocketClient("multi-A", port);
    const client2 = new SocketClient("multi-B", port);
    const client3 = new SocketClient("multi-C", port);

    const connections: string[] = [];
    server.on("agent_connected", (id: string) => connections.push(id));

    await client1.connect();
    await client2.connect();
    await client3.connect();

    await new Promise((r) => setTimeout(r, 100));

    expect(connections).toContain("multi-A");
    expect(connections).toContain("multi-B");
    expect(connections).toContain("multi-C");
    expect(server.agentCount).toBe(3);

    client1.disconnect();
    client2.disconnect();
    client3.disconnect();
  });

  it("targeted notification only delivers to specified agents", async () => {
    const clientA = new SocketClient("agent-A", port);

    const aReceived = new Promise<SocketMessage>((resolve) => {
      clientA.on("lock_released", (msg) => resolve(msg as SocketMessage));
    });

    await clientA.connect();
    // Wait for registration to complete (client sends register on connect)
    await new Promise((r) => setTimeout(r, 100));

    expect(server.isConnected("agent-A")).toBe(true);

    // Send directly via sendToAgent
    const sent = server.sendToAgent("agent-A", { type: "lock_released", file: "src/shared.ts" });
    expect(sent).toBe(true);

    const msg = await Promise.race([aReceived, timeout(2000)]);
    expect(msg.file).toBe("src/shared.ts");

    clientA.disconnect();
  });

  it("sendToAgents returns list of agents that received", async () => {
    const client = new SocketClient("agent-target", port);
    await client.connect();
    await new Promise((r) => setTimeout(r, 50));

    const received = server.sendToAgents(
      ["agent-target", "nonexistent"],
      { type: "warning", message: "test" }
    );
    expect(received).toContain("agent-target");
    expect(received).not.toContain("nonexistent");

    client.disconnect();
  });

  it("sendToAgent returns false for disconnected agent", () => {
    const result = server.sendToAgent("nonexistent", { type: "ping" });
    expect(result).toBe(false);
  });

  it("pingAgent returns false for disconnected agent", () => {
    const result = server.pingAgent("nonexistent");
    expect(result).toBe(false);
  });

  it("handles change_query and returns change_result", async () => {
    const client = new SocketClient("agent-query", port);

    // Set up server-side handler for change_query
    server.on("change_query", (agentId: string, reqId: string, qtype: string, files?: string[], since?: number) => {
      server.sendChangeResult(agentId, reqId, [
        { id: "change-1", type: "file", timestamp: Date.now(), file: "src/a.ts", agent_id: "agent-002" },
      ]);
    });

    await client.connect();
    await new Promise((r) => setTimeout(r, 50));

    const results = await client.queryChanges({ files: ["src/a.ts"] });
    expect(results).toHaveLength(1);
    expect((results as Record<string, unknown>[])[0].type).toBe("file");

    client.disconnect();
  });

  it("handles change_query with qtype filter", async () => {
    const client = new SocketClient("agent-query-type", port);

    server.on("change_query", (agentId: string, reqId: string) => {
      server.sendChangeResult(agentId, reqId, [
        { id: "k1", type: "knowledge", timestamp: Date.now(), task_id: "t1", agent_id: "agent-001", summary: "test" },
      ]);
    });

    await client.connect();
    await new Promise((r) => setTimeout(r, 50));

    const results = await client.queryChanges({ qtype: "knowledge" });
    expect(results).toHaveLength(1);
    expect((results as Record<string, unknown>[])[0].type).toBe("knowledge");

    client.disconnect();
  });
});

/**
 * Helper: timeout promise that rejects after ms.
 */
function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
  });
}
