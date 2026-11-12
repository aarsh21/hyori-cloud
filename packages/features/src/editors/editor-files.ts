import type { OutputOf, RPC } from "@hyori-cloud/client-sdk";

export type AvailableEditor = OutputOf<RPC["editors"]["available"]>["apps"][number];

/**
 * Which of the server's available editors, if any, accepts this file. The server alone decides on
 * opening: this only says whether offering it makes sense.
 */
export function editorForFile(name: string, editors: readonly AvailableEditor[]) {
  const dot = name.lastIndexOf(".");

  if (dot < 0) return undefined;

  const extension = name.slice(dot).toLowerCase();

  return editors.find(({ inputExtensions }) => inputExtensions.includes(extension));
}
