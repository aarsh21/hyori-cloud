export function present(state: { phase: "pending" | "complete" }) {
  switch (state.phase) {
    case "pending":
      return "Pending";
    case "complete":
      return "Complete";
  }

  state.phase satisfies never;

  return "";
}
