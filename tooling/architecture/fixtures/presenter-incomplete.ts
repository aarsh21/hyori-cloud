export function present(state: { phase: "pending" | "complete" | "failed" }) {
  switch (state.phase) {
    case "pending":
      return "Pending";
    case "complete":
      return "Complete";
  }

  return "";
}
