import { describe, expect, it } from "vitest";
import { ar } from "@/i18n/resources/ar";
import { en } from "@/i18n/resources/en";
import { es } from "@/i18n/resources/es";
import { fr } from "@/i18n/resources/fr";
import { ja } from "@/i18n/resources/ja";
import { ko } from "@/i18n/resources/ko";
import { ptBR } from "@/i18n/resources/pt-BR";
import { ru } from "@/i18n/resources/ru";
import { zhCN } from "@/i18n/resources/zh-CN";

const locales = { ar, en, es, fr, ja, ko, "pt-BR": ptBR, ru, "zh-CN": zhCN };

describe("the JSON tree's counts", () => {
  // i18next looks up the count's plural category and falls back to English, not to `_other`.
  it.each(Object.entries(locales))("has every plural form %s uses", (locale, resource) => {
    const strings = resource.panels.file.json as Record<string, string>;
    const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
    for (const key of ["items", "keys"]) {
      for (const category of categories) {
        expect(strings[`${key}_${category}`], `${locale} ${key}_${category}`).toBeTypeOf("string");
      }
    }
  });
});
