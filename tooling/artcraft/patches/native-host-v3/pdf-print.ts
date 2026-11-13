let clearPrevious: (() => void) | undefined;

/** Print in this opaque document: a nested srcdoc gets another opaque origin and loses its blobs. */
export async function printDocument(html: string) {
  clearPrevious?.();
  // Even an inert DOMParser document checks inline CSS against the frame's CSP.
  const css = html.match(/<style>([\s\S]*?)<\/style>/u)?.[1];

  const markup = html
    .replace(/<style>[\s\S]*?<\/style>/u, "")
    .replaceAll(' style="', ' data-hyori-print-style="');

  const parsed = new DOMParser().parseFromString(markup, "text/html");
  const root = document.createElement("section");
  const sheet = new CSSStyleSheet();

  root.id = "hyori-print-pages";
  root.setAttribute("aria-hidden", "true");

  if (!css || parsed.body.children.length === 0) throw new Error("No print pages were prepared");

  // Only the Rust renderer's generated div/img tree is accepted, never document HTML/scripts.
  for (const element of parsed.body.querySelectorAll("*")) {
    if (!["DIV", "IMG"].includes(element.tagName)) throw new Error("Unexpected print content");
  }

  const rules = [
    "@media screen { #hyori-print-pages { display: none } }",
    "@media print { html, body { height: auto !important; overflow: visible !important } body > :not(#hyori-print-pages) { display: none !important } }",
  ];

  // Constructed sheets don't need an inline-style CSP exception. Scope upstream selectors to
  // printing, and turn its trusted numeric image dimensions into rules before inserting nodes.
  let index = 0;

  for (const image of parsed.body.querySelectorAll("img")) {
    if (!image.src.startsWith("blob:") || new URL(image.src).origin !== window.origin)
      throw new Error("Print image is not this document's blob");
    const dimensions = image.getAttribute("data-hyori-print-style");

    if (dimensions !== null) {
      if (!/^width:[0-9.]+pt;height:[0-9.]+pt$/u.test(dimensions))
        throw new Error("Unexpected print dimensions");
      image.removeAttribute("data-hyori-print-style");
      image.id = `hyori-print-image-${index++}`;
      rules.push(`@media print { #${image.id} { ${dimensions} } }`);
    }
  }

  sheet.replaceSync(`${rules.join("\n")}\n@media print { ${css} }`);
  root.append(...parsed.body.childNodes);
  document.body.append(root);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

  try {
    await Promise.all(Array.from(root.querySelectorAll("img"), (image) => image.decode()));
    await new Promise<void>((resolve, reject) => {
      const clear = () => {
        window.removeEventListener("afterprint", clear);
        root.remove();
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((value) => value !== sheet);
        clearPrevious = undefined;
        resolve();
      };

      clearPrevious = clear;
      window.addEventListener("afterprint", clear, { once: true });

      try {
        window.print();
      } catch (error) {
        reject(error);
        clear();
      }
    });
  } catch (error) {
    root.remove();
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((value) => value !== sheet);
    throw error;
  }
}
