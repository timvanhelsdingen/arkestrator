/**
 * A simple in-memory transport for stateless MCP request handling.
 * Works with Bun (no Node.js http.ServerResponse dependency).
 * Each request creates a fresh transport, sends the message through,
 * captures the response, and disconnects.
 *
 * Important: MCP notifications (messages with no "id") never produce a
 * JSON-RPC response. handleMessage returns null for notifications so the
 * HTTP handler can respond with 202 Accepted without hanging.
 */

import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";

export class StatelessTransport implements Transport {
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  sessionId?: string;

  private responseResolve?: (message: JSONRPCMessage) => void;
  private responsePromise?: Promise<JSONRPCMessage>;

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    // Server is sending a response — capture it
    if (this.responseResolve) {
      this.responseResolve(message);
    }
  }

  async close(): Promise<void> {
    this.onclose?.();
  }

  /**
   * Deliver an incoming JSON-RPC message and wait for the server's response.
   * Returns null for notifications (no "id") — they have no JSON-RPC response.
   */
  async handleMessage(message: JSONRPCMessage): Promise<JSONRPCMessage | null> {
    // Notifications have no id — the MCP server never calls send() for them.
    // Return null immediately so the HTTP handler can respond with 202.
    const hasId = "id" in message && message.id !== undefined && message.id !== null;
    if (!hasId) {
      this.onmessage?.(message);
      return null;
    }

    this.responsePromise = new Promise<JSONRPCMessage>((resolve) => {
      this.responseResolve = resolve;
    });

    // Deliver to the MCP server
    this.onmessage?.(message);

    // Wait for the server to call send() with the response
    return this.responsePromise;
  }
}
