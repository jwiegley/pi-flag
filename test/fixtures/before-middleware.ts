import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function beforeMiddleware(pi: ExtensionAPI): void {
  pi.on("input", (event) => ({
    action: "transform",
    text: `before:${event.text}`,
    ...(event.images === undefined ? {} : { images: event.images }),
  }));
  pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\nEARLY-MIDDLEWARE` }));
}
