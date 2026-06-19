import {
  createPlaygroundWorkerSource,
  isTrustedPlaygroundWorkerMessage,
  type PlaygroundWorkerMessage,
} from "./runner-source";

export const PLAYGROUND_IFRAME_SANDBOX = "allow-scripts";

type PlaygroundRunnerMessage =
  | {
      type: "log" | "error" | "cache";
      message: string;
      timestamp: number;
      runId: string;
    }
  | {
      type: "done";
      layerInfo: unknown;
      stats: unknown;
      runId: string;
    };

type PlaygroundRunnerOptions = {
  code: string;
  onMessage: (message: PlaygroundRunnerMessage) => void;
  onError: (message: string) => void;
};

type PlaygroundRunHandle = {
  stop: () => void;
};

function createNonce(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) {
    return cryptoApi.randomUUID();
  }

  const bytes = new Uint8Array(16);
  cryptoApi?.getRandomValues?.(bytes);
  if (bytes.some((byte) => byte !== 0)) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createPlaygroundFrameSource(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; connect-src 'none'; img-src 'none'; style-src 'unsafe-inline';"
    />
  </head>
  <body>
    <script>
      (() => {
        let activeWorker = null;
        let activeWorkerUrl = null;

        const stopWorker = () => {
          if (activeWorker) {
            activeWorker.terminate();
            activeWorker = null;
          }
          if (activeWorkerUrl) {
            URL.revokeObjectURL(activeWorkerUrl);
            activeWorkerUrl = null;
          }
        };

        window.addEventListener("message", (event) => {
          if (event.source !== window.parent) {
            return;
          }

          const data = event.data || {};
          if (
            data.type !== "run" ||
            typeof data.code !== "string" ||
            typeof data.runId !== "string" ||
            typeof data.messageToken !== "string" ||
            typeof data.workerSource !== "string"
          ) {
            return;
          }

          stopWorker();
          const { code, runId, messageToken, workerSource } = data;
          activeWorkerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
          activeWorker = new Worker(activeWorkerUrl);

          activeWorker.onmessage = (workerEvent) => {
            const message = workerEvent.data || {};
            if (message.messageToken !== messageToken || message.runId !== runId) {
              return;
            }

            const { messageToken: _messageToken, ...payload } = message;
            window.parent.postMessage(payload, "*");

            if (payload.type === "done") {
              stopWorker();
            }
          };

          activeWorker.onerror = (error) => {
            window.parent.postMessage(
              {
                type: "error",
                message: "Worker error: " + (error.message || "execution failed"),
                timestamp: Date.now(),
                runId,
              },
              "*"
            );
            window.parent.postMessage({ type: "done", layerInfo: undefined, stats: undefined, runId }, "*");
            stopWorker();
          };

          activeWorker.postMessage({ type: "run", code, runId, messageToken });
        });

        window.addEventListener("pagehide", stopWorker);
      })();
    </script>
  </body>
</html>`;
}

export function runPlaygroundInSandbox({
  code,
  onMessage,
  onError,
}: PlaygroundRunnerOptions): PlaygroundRunHandle {
  const iframe = document.createElement("iframe");
  const runId = createNonce();
  const messageToken = createNonce();
  let stopped = false;

  iframe.setAttribute("sandbox", PLAYGROUND_IFRAME_SANDBOX);
  iframe.setAttribute("aria-hidden", "true");
  iframe.referrerPolicy = "no-referrer";
  iframe.style.position = "absolute";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  iframe.style.pointerEvents = "none";
  iframe.style.opacity = "0";

  const cleanup = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    window.removeEventListener("message", handleMessage);
    iframe.remove();
  };

  const handleMessage = (event: MessageEvent<PlaygroundRunnerMessage>) => {
    if (event.source !== iframe.contentWindow) {
      return;
    }

    const message = event.data;
    if (!message || message.runId !== runId) {
      return;
    }

    onMessage(message);
    if (message.type === "done") {
      cleanup();
    }
  };

  iframe.addEventListener(
    "load",
    () => {
      if (stopped || !iframe.contentWindow) {
        return;
      }

      iframe.contentWindow.postMessage(
        {
          type: "run",
          code,
          runId,
          messageToken,
          workerSource: createPlaygroundWorkerSource(),
        },
        "*"
      );
    },
    { once: true }
  );

  iframe.addEventListener("error", () => {
    onError("Sandbox frame failed to load.");
    cleanup();
  });

  window.addEventListener("message", handleMessage);
  iframe.srcdoc = createPlaygroundFrameSource();
  document.body.appendChild(iframe);

  return {
    stop: cleanup,
  };
}

export { isTrustedPlaygroundWorkerMessage };
export type { PlaygroundWorkerMessage };
