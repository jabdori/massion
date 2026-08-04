export const SUPPORTED_LOCALES = ["en", "ko"] as const;

export type AppLocale = (typeof SUPPORTED_LOCALES)[number];
export type LanguagePreference = "system" | AppLocale;

export const LANGUAGE_STORAGE_KEY = "massion.language.v1";

export function systemLocale(language: string | undefined): AppLocale {
  return language?.trim().toLowerCase().split(/[-_]/u)[0] === "ko" ? "ko" : "en";
}

export function languagePreference(value: string | null | undefined): LanguagePreference {
  return value === "en" || value === "ko" ? value : "system";
}

export function effectiveLocale(preference: LanguagePreference, language: string | undefined): AppLocale {
  return preference === "system" ? systemLocale(language) : preference;
}

export function localeTag(locale: AppLocale): "en-US" | "ko-KR" {
  return locale === "ko" ? "ko-KR" : "en-US";
}

export function normalizeSearch(value: string, locale: AppLocale): string {
  return value.normalize("NFKC").toLocaleLowerCase(localeTag(locale)).trim();
}

export function formatNumber(value: number, locale: AppLocale): string {
  return new Intl.NumberFormat(localeTag(locale)).format(value);
}

export function formatCompactNumber(value: number, locale: AppLocale): string {
  return new Intl.NumberFormat(localeTag(locale), { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function formatDateTime(value: string | Date, locale: AppLocale): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(localeTag(locale), {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
