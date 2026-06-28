import * as net from "node:net";
import { EventEmitter } from "node:events";
import type { SocketMessage } from "./socket-server";

/**
 * Socket Client — used by Agent workers to connect to the scheduler.
 *
 * Features:
 * - Auto-reconnect with exponential backoff
 * - JSON-line protocol
 * - Non-blocking event-driven receive
 */

export class SocketClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private host: string;
  private port: number;
  private agentId: string;
  private buffer = "";
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = true;

  constructor(agentId: string, port: number, host = "127.0.0.1") {
    super();
    this.agentId = agentId;
    this.port = port;
    this.host = host;
  }

  /**
   * Connect to the scheduler's TCP server.
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();

      const onError = (err: Error) => {
        reject(err);
      };

      this.socket.once("connect", () => {
        this.socket!.removeListener("error", onError);
        this.reconnectAttempts = 0;

        // Register with the scheduler
        this.send({ type: "register", agent_id: this.agentId });

        this.emit("connected");
        resolve();
      });

      this.socket.once("error", onError);

      this.socket.on("data", (data: Buffer) => {
        this.buffer += data.toString("utf-8");
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg: SocketMessage = JSON.parse(line);
            this.emit("message", msg);
            this.emit(msg.type, msg);
          } catch {
            // Ignore malformed messages
          }
        }
      });

      this.socket.on("close", () => {
        this.emit("disconnected");
        this.socket = null;

        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });

      this.socket.on("error", () => {
        // 'close' will fire after 'error', handling reconnection there
      });

      this.socket.connect(this.port, this.host);
    });
  }

  /**
   * Send a message to the scheduler.
   */
  send(message: SocketMessage): boolean {
    if (!this.socket || this.socket.destroyed) {
      return false;
    }

    try {
      this.socket.write(JSON.stringify(message) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send a heartbeat message with current lock list.
   */
  sendHeartbeat(locks: string[]): boolean {
    return this.send({
      type: "heartbeat",
      agent_id: this.agentId,
      locks,
    });
  }

  /**
   * Notify the scheduler that a task is done.
   */
  notifyTaskDone(taskId: string, summary?: string): boolean {
    return this.send({
      type: "task_done",
      agent_id: this.agentId,
      task_id: taskId,
      summary,
    });
  }

  /**
   * Notify the scheduler that a task has failed.
   */
  notifyTaskFailed(taskId: string, reason: string): boolean {
    return this.send({
      type: "task_failed",
      agent_id: this.agentId,
      task_id: taskId,
      reason,
    });
  }

  /**
   * Notify the scheduler that files have been modified and locks can be released.
   * Used for fine-grained lock release — agent reports files it's done with.
   */
  notifyFilesModified(files: string[], worktree: string): boolean {
    return this.send({
      type: "file_modified",
      agent_id: this.agentId,
      files,
      worktree,
    });
  }

  /**
   * Request locks for additional files during task execution.
   */
  requestLocks(taskId: string, files: string[], opts?: { skipPropagation?: boolean }): boolean {
    return this.send({
      type: "lock_request",
      agent_id: this.agentId,
      task_id: taskId,
      files,
      skip_propagation: opts?.skipPropagation === true ? true : undefined,
    });
  }

  /**
   * Request locks and wait for a response (Promise-based, for sync flows).
   * Returns the granted files array, or throws if denied.
   *
   * @param opts.skipPropagation - If true, the scheduler will NOT propagate
   *   dirty files into the worktree before granting the lock. Used by post-hoc
   *   lock expansion, where the agent already modified the file locally.
   */
  async requestLocksAsync(taskId: string, files: string[], opts?: { skipPropagation?: boolean }): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const INITIAL_TIMEOUT_MS = 45000; // 45s — gives 15s margin over scheduler's 30s refresh
      let timeout: NodeJS.Timeout;

      const createTimeout = () => setTimeout(() => {
        this.off("lock_granted", onGranted);
        this.off("lock_denied", onDenied);
        this.off("lock_waiting", onWaiting);
        reject(new Error(`Lock request timed out for task ${taskId.slice(0, 8)}`));
      }, INITIAL_TIMEOUT_MS);

      timeout = createTimeout();

      const onGranted = (msg: SocketMessage) => {
        if (msg.task_id === taskId) {
          clearTimeout(timeout);
          this.off("lock_denied", onDenied);
          this.off("lock_waiting", onWaiting);
          resolve((msg.files as string[]) ?? []);
        }
      };

      const onDenied = (msg: SocketMessage) => {
        if (msg.task_id === taskId) {
          clearTimeout(timeout);
          this.off("lock_granted", onGranted);
          this.off("lock_waiting", onWaiting);
          reject(new Error((msg.reason as string) ?? "Lock request denied"));
        }
      };

      // lock_waiting: the scheduler has queued our request and will retry
      // when the lock becomes available. Reset the timeout to keep waiting.
      const onWaiting = (msg: SocketMessage) => {
        if (msg.task_id === taskId) {
          console.log(`[socket-client] Lock request queued: ${msg.reason}`);
          clearTimeout(timeout);
          timeout = createTimeout();
        }
      };

      this.on("lock_granted", onGranted);
      this.on("lock_denied", onDenied);
      this.on("lock_waiting", onWaiting);

      // Send the request
      const sent = this.send({
        type: "lock_request",
        agent_id: this.agentId,
        task_id: taskId,
        files,
        skip_propagation: opts?.skipPropagation === true ? true : undefined,
      });

      if (!sent) {
        clearTimeout(timeout);
        this.off("lock_granted", onGranted);
        this.off("lock_denied", onDenied);
        this.off("lock_waiting", onWaiting);
        reject(new Error("Failed to send lock request (not connected)"));
      }
    });
  }

  /**
   * Query the scheduler's ChangeJournal for recent changes.
   * Pull-based — only returns what the agent asks for.
   */
  queryChanges(filter: {
    qtype?: string;
    files?: string[];
    since?: number;
  }): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      const reqId = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
      const TIMEOUT_MS = 15_000;
      let timeout: NodeJS.Timeout;

      const onResult = (msg: SocketMessage) => {
        if (msg.req_id === reqId) {
          clearTimeout(timeout);
          this.off("change_result", onResult);
          resolve((msg.changes as unknown[]) ?? []);
        }
      };

      timeout = setTimeout(() => {
        this.off("change_result", onResult);
        reject(new Error("Change journal query timed out"));
      }, TIMEOUT_MS);

      this.on("change_result", onResult);

      const sent = this.send({
        type: "change_query",
        agent_id: this.agentId,
        req_id: reqId,
        qtype: filter.qtype,
        files: filter.files,
        since: filter.since,
      });

      if (!sent) {
        clearTimeout(timeout);
        this.off("change_result", onResult);
        reject(new Error("Failed to send change_query (not connected)"));
      }
    });
  }

  /**
   * Disconnect from the scheduler.
   */
  disconnect(): void {
    this.shouldReconnect = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  /**
   * Check if the client is currently connected.
   */
  get isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  // ---- Internal ----

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;

    // Exponential backoff: 1s, 2s, 4s, 8s, ..., max 30s
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch {
        // Will schedule another reconnect via 'close' event
      }
    }, delay);
  }
}
