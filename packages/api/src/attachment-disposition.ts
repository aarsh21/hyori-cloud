/** Legacy names may predate validation. Repair lone surrogates before URI encoding. */
export function attachmentDisposition(name: string): string {
  const wellFormed = name.replace(/[\uD800-\uDFFF]/gu, "�");

  const encoded = encodeURIComponent(wellFormed).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `attachment; filename*=UTF-8''${encoded}`;
}
