/** Folders have no size of their own. The dash is for the eye; a screen reader gets the words. */
export function NoSize() {
  return (
    <>
      <span aria-hidden>-</span>
      <span className="sr-only">No size</span>
    </>
  );
}
