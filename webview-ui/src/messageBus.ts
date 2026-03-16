/**
 * Message bus replacing VS Code's postMessage API.
 * Components dispatch messages here; the OpenClaw adapter listens and responds.
 * Incoming messages (from adapter) are dispatched as window MessageEvents
 * so existing useExtensionMessages handler works unchanged.
 */

type MessageHandler = (msg: Record<string, unknown>) => void;

const outboundHandlers: Set<MessageHandler> = new Set();

/** Subscribe to outbound messages (messages the UI sends "out") */
export function onOutboundMessage(handler: MessageHandler): () => void {
  outboundHandlers.add(handler);
  return () => {
    outboundHandlers.delete(handler);
  };
}

/** Send a message from the UI outward (replaces vscode.postMessage) */
export function postMessage(msg: Record<string, unknown>): void {
  for (const handler of outboundHandlers) {
    handler(msg);
  }
}

/** Push an inbound message to the UI (replaces extension posting to webview) */
export function dispatchToWebview(msg: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent('message', { data: msg }));
}

/**
 * Drop-in replacement for the old vscode API object.
 * Import { vscode } from './messageBus.js' instead of './vscodeApi.js'.
 */
export const vscode = {
  postMessage: postMessage as (msg: unknown) => void,
};
