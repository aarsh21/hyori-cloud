import { hostOutgoingMessage, type HostOutgoing } from "./host-protocol.ts";

// Synthetic host fixture only: acknowledgements are deliberately NOT a cloud persistence claim.
const initialFrame = document.querySelector("iframe");

if (!initialFrame) throw new Error("Missing synthetic test frame");

const initialTarget = initialFrame.contentWindow;

if (!initialTarget) throw new Error("Missing editor window");

let frame = initialFrame;
let target = initialTarget;
let nextInput: Uint8Array<ArrayBuffer> | null = null;
let openGeneration = 1;
let acknowledgedSave: string | null = null;

const origin = window.location.origin;
const version = "0.14.1-hyori-host.1";
const messages: HostOutgoing[] = [];
let saved: Uint8Array | null = null;
let saveId: string | null = null;

window.addEventListener("message", (event) => {
  if (event.origin !== origin || event.source !== target) return;
  const parsed = hostOutgoingMessage.safeParse(event.data);

  if (!parsed.success || parsed.data.version !== version) return;
  const message = parsed.data;
  messages.push(message);

  if (message.type === "deckcraft:ready") {
    const input = nextInput
      ? Promise.resolve(new Uint8Array(nextInput).buffer)
      : fetch("/synthetic.deckcraft").then((response) => response.arrayBuffer());

    void input.then((bytes) =>
      target.postMessage(
        {
          type: "deckcraft:open",
          protocol: 1,
          version,
          openId: `synthetic-open-${openGeneration}`,
          name: "Synthetic.deckcraft",
          bytes,
          maxBytes: 1024 * 1024,
          writable: true,
          replacementName: "Synthetic.deckcraft",
          outputFormats: [{ extension: ".deckcraft", kind: "document" }],
        },
        origin,
      ),
    );
  }

  if (message.type === "deckcraft:saved" && !message.dirty) acknowledgedSave = message.saveId;

  if (message.type === "deckcraft:save") {
    saved = new Uint8Array(message.bytes);
    saveId = message.saveId;
  }
});

const fixture = {
  waitFor(type: HostOutgoing["type"], count = 1) {
    return new Promise<boolean>((resolve, reject) => {
      const check = () => {
        if (messages.filter((message) => message.type === type).length >= count) {
          clearTimeout(timer);
          window.removeEventListener("message", check);
          resolve(true);
        }
      };

      const timer = setTimeout(() => {
        window.removeEventListener("message", check);
        reject(new Error(`Timed out waiting for ${type}`));
      }, 120_000);

      window.addEventListener("message", check);
      check();
    });
  },
  observations() {
    return messages.map((message) =>
      message.type === "deckcraft:save" ? { ...message, bytes: message.bytes.length } : message,
    );
  },
  focus() {
    target.focus();
    frame.contentDocument?.querySelector("canvas")?.focus();
  },
  acknowledge(status: "saved" | "conflict") {
    if (!saveId) throw new Error("No pending synthetic save");
    target.postMessage(
      {
        type: "deckcraft:save-result",
        protocol: 1,
        version,
        saveId,
        status,
        ...(status === "saved"
          ? { revision: "synthetic-r2" }
          : { message: "Synthetic revision conflict" }),
      },
      origin,
    );
  },
  output() {
    return saved ? Array.from(saved) : null;
  },
  reopen() {
    if (!saved || !saveId || acknowledgedSave !== saveId)
      throw new Error("Reopen requires an acknowledged current snapshot");
    nextInput = new Uint8Array(saved);
    frame.remove();
    frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    frame.title = "Reopened synthetic editor fixture";
    document.body.appendChild(frame);
    const freshTarget = frame.contentWindow;

    if (!freshTarget) throw new Error("Fresh editor window missing");
    target = freshTarget;
    acknowledgedSave = null;
    openGeneration += 1;
    frame.src = "/editor/index.html?host=parent&webgl";
  },
};

declare global {
  interface Window {
    deckFixture: typeof fixture;
  }
}

window.deckFixture = fixture;

frame.src = "/editor/index.html?host=parent&webgl";
