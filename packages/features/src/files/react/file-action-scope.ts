import { object, string } from "@hyori-cloud/lib/json";

/** Local mutation ownership, never part of an RPC payload. */
export type FileActionScope = { readonly fileActionsOwner: string };

const target = object({ id: string() });

export function isItemTarget(value: unknown): value is { readonly id: string } {
  return target.safeParse(value).success;
}
