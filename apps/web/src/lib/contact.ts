const EMAIL_PATTERN = /^[^\s@<>?,;:'"()[\]\\]+@[^\s@<>?,;:'"()[\]\\]+\.[^\s@<>?,;:'"()[\]\\]{2,}$/;

export function cleanEnvValue(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function cleanEmail(value?: string): string | undefined {
  const cleaned = cleanEnvValue(value);
  if (!cleaned || cleaned.length > 320 || !EMAIL_PATTERN.test(cleaned)) {
    return undefined;
  }
  return cleaned;
}
