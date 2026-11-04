export function formText(values: FormData, name: string): string {
  const value = values.get(name);

  if (value === null || value instanceof File) return "";

  return value;
}

export function optionalFormText(values: FormData, name: string): string | undefined {
  const value = formText(values, name).trim();

  return value === "" ? undefined : value;
}
