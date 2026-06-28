import * as net from "node:net";
import { EventEmitter } from "node:events";

/**
 * Socket message protocol (JSON lines over TCP).
 *
 * Agent → Server:
 *   {"type":"register","agent_id":"agent-001"}
 *   {"type":"heartbeat","agent_id":"agent-001","locks":["src/auth.ts"]}
 *   {"type":"task_done","agent_id":"agent-001","task_id":"uuid","summary":"..."}
 *   {"type":"task_failed","agent_id":"agent-001","task_id":"uuid","reason":"..."}
 *   {"type":"lock_request","agent_id":"agent-001","task_id":"uuid","files":["src/x.ts"]}
 *   {"type":"file_modified","agent_id":"agent-001","files":["src/auth.ts"],"worktree":"/path/to/wt"}
 *   {"type":"change_query","agent_id":"agent-001","req_id":"uuid","qtype":"file","files":["src/x.ts"],"since":1719600000}
 *
 * Server → Agent:
 *   {"type":"ping"}
 *   {"type":"shutdown"}
 *   {"type":"lock_released","file":"src/auth.ts"}
 *   {"type":"merge_completed","task_id":"uuid"}
 *   {"type":"warning","task_id":"uuid","message":"..."}
 *   {"type":"lease_expired","file":"src/auth.ts"}
 *   {"type":"lock_waiting","task_id":"uuid","files":["src/x.ts"],"reason":"Waiting for lock held by agent-002"}
 *   {"type":"lock_granted","task_id":"uuid","files":["src/x.ts"]}
 *   {"type":"lock_denied","task_id":"uuid","files":["src/x.ts"],"reason":"Deadlock detected"}
 *   {"type":"file_propagate","file":"src/auth.ts","source_worktree":"/path/to/wt1","source_agent":"agent-001"}
 *   {"type":"knowledge_updated","task_id":"uuid","agent_id":"agent-001","summary":"Refactored auth module"}
 *   {"type":"change_result","req_id":"uuid","changes":[{...}]}
 */

export interface SocketMessage {
  type: string;
  [key: string]: unknown;
}

export interface AgentConnection {
  socket: net.Socket;
  agentId: string;
  connectedAt: number;
}

export class SocketServer extends EventEmitter {
  private server: net.Server | null = null;
  private agents = new Map<string, AgentConnection>();
  private port: number;

  constructor(port: number) {
    super();
    this.port = port;
  }

  /**
   * Start the TCP server and begin accepting agent connections.
   */
  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          reject(new Error(`Port ${this.port} is already in use`));
        } else {
          reject(err);
        }
      });

      this.server.listen(this.port, "127.0.0.1", () => {
        resolve(this.port);
      });
    });
  }

  /**
   * Stop the server and disconnect all agents.
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      // Disconnect all agents
      for (const [id, conn] of this.agents) {
        conn.socket.destroy();
      }
      this.agents.clear();

      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Send a message to a specific agent.
   */
  sendToAgent(agentId: string, message: SocketMessage): boolean {
    const conn = this.agents.get(agentId);
    if (!conn || conn.socket.destroyed) {
      return false;
    }

    try {
      conn.socket.write(JSON.stringify(message) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send a message to multiple agents.
   * Returns the list of agent IDs that received the message.
   */
  sendToAgents(agentIds: string[], message: SocketMessage): string[] {
    const received: string[] = [];
    for (const id of agentIds) {
      if (this.sendToAgent(id, message)) {
        received.push(id);
      }
    }
    return received;
  }

  /**
   * Send a ping to an agent to check if it's alive.
   * Returns true if the ping was sent (not necessarily received).
   */
  pingAgent(agentId: string): boolean {
    return this.sendToAgent(agentId, { type: "ping" });
  }

  /**
   * Broadcast a message to all connected agents.
   */
  broadcast(message: SocketMessage): void {
    for (const agentId of this.agents.keys()) {
      this.sendToAgent(agentId, message);
    }
  }

  /**
   * Send a lock_granted message to an agent.
   */
  sendLockGranted(agentId: string, taskId: string, files: string[]): boolean {
    return this.sendToAgent(agentId, {
      type: "lock_granted",
      task_id: taskId,
      files,
    });
  }

  /**
   * Send a lock_waiting message to an agent — the lock is held by
   * another agent but the request is queued and will be retried.
   */
  sendLockWaiting(agentId: string, taskId: string, files: string[], reason: string): boolean {
    return this.sendToAgent(agentId, {
      type: "lock_waiting",
      task_id: taskId,
      files,
      reason,
    });
  }

  /**
   * Send a lock_denied message to an agent.
   */
  sendLockDenied(agentId: string, taskId: string, files: string[], reason: string): boolean {
    return this.sendToAgent(agentId, {
      type: "lock_denied",
      task_id: taskId,
      files,
      reason,
    });
  }

  /**
   * Tell an agent to propagate a file from another agent's worktree.
   * Used when a file was modified by one agent and another agent needs the latest version.
   */
  sendFilePropagate(agentId: string, file: string, sourceWorktree: string, sourceAgent: string): boolean {
    return this.sendToAgent(agentId, {
      type: "file_propagate",
      file,
      source_worktree: sourceWorktree,
      source_agent: sourceAgent,
    });
  }

  /**
   * Send change journal query results back to a specific agent.
   */
  sendChangeResult(agentId: string, reqId: string, changes: unknown[]): boolean {
    return this.sendToAgent(agentId, {
      type: "change_result",
      req_id: reqId,
      changes,
    });
  }

  /**
   * Push a lock_released event only to agents whose current task
   * involves the released file (targeted push, not broadcast).
   */
  notifyLockReleased(file: string, interestedAgents: string[]): void {
    this.sendToAgents(interestedAgents, {
      type: "lock_released",
      file,
    });
  }

  /**
   * Check if an agent is currently connected.
   */
  isConnected(agentId: string): boolean {
    const conn = this.agents.get(agentId);
    return conn !== undefined && !conn.socket.destroyed;
  }

  /**
   * Get all connected agent IDs.
   */
  getConnectedAgents(): string[] {
    return Array.from(this.agents.keys());
  }

  /**
   * Get the number of connected agents.
   */
  get agentCount(): number {
    return this.agents.size;
  }

  // ---- Internal ----

  private handleConnection(socket: net.Socket): void {
    let agentId: string | null = null;
    let buffer = "";

    socket.on("data", (data: Buffer) => {
      buffer += data.toString("utf-8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const msg: SocketMessage = JSON.parse(line);
          this.handleMessage(socket, msg, (id) => { agentId = id; });
        } catch {
          // Ignore malformed JSON
        }
      }
    });

    socket.on("close", () => {
      if (agentId) {
        this.agents.delete(agentId);
        this.emit("agent_disconnected", agentId);
      }
    });

    socket.on("error", (err: Error) => {
      if (agentId) {
        this.agents.delete(agentId);
        this.emit("agent_disconnected", agentId);
      }
    });
  }

  private handleMessage(
    socket: net.Socket,
    msg: SocketMessage,
    setId: (id: string) => void
  ): void {
    switch (msg.type) {
      case "register": {
        const agentId = msg.agent_id as string;
        if (!agentId) return;

        // If an agent with this ID was already connected, disconnect the old one
        const existing = this.agents.get(agentId);
        if (existing) {
          existing.socket.destroy();
        }

        const conn: AgentConnection = {
          socket,
          agentId,
          connectedAt: Date.now(),
        };

        this.agents.set(agentId, conn);
        setId(agentId);
        this.emit("agent_connected", agentId);
        break;
      }

      case "heartbeat": {
        const agentId = msg.agent_id as string;
        if (!agentId) return;
        this.emit("heartbeat_received", agentId, msg.locks ?? []);
        break;
      }

      case "task_done": {
        const agentId = msg.agent_id as string;
        const taskId = msg.task_id as string;
        const summary = msg.summary as string | undefined;
        if (!agentId || !taskId) return;
        this.emit("task_completed", agentId, taskId, summary);
        break;
      }

      case "task_failed": {
        const agentId = msg.agent_id as string;
        const taskId = msg.task_id as string;
        const reason = msg.reason as string ?? "unknown";
        if (!agentId || !taskId) return;
        this.emit("task_failed", agentId, taskId, reason);
        break;
      }

      case "lock_request": {
        const agentId = msg.agent_id as string;
        const taskId = msg.task_id as string;
        const files = msg.files as string[] ?? [];
        const skipPropagation = msg.skip_propagation as boolean ?? false;
        if (!agentId || !taskId || files.length === 0) return;
        this.emit("lock_request", agentId, taskId, files, skipPropagation);
        break;
      }

      case "file_modified": {
        const agentId = msg.agent_id as string;
        const files = msg.files as string[] ?? [];
        const worktree = msg.worktree as string ?? "";
        if (!agentId || files.length === 0) return;
        this.emit("file_modified", agentId, files, worktree);
        break;
      }

      case "change_query": {
        const agentId = msg.agent_id as string;
        const reqId = msg.req_id as string;
        const qtype = (msg.qtype as string) ?? "all";
        const files = msg.files as string[] | undefined;
        const since = msg.since as number | undefined;
        if (!agentId || !reqId) return;
        this.emit("change_query", agentId, reqId, qtype, files, since);
        break;
      }

      case "shutdown": {
        this.emit("shutdown_requested");
        break;
      }

      default:
        // Unknown message type — ignore
        break;
    }
  }
}
