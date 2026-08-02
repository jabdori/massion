import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { I18nProvider, translate, useI18n } from "./context";
import { LANGUAGE_STORAGE_KEY } from "./locale";

function Probe() {
  const { locale, preference, setPreference, systemLocale } = useI18n();
  return (
    <div>
      <output aria-label="locale">{locale}</output>
      <output aria-label="preference">{preference}</output>
      <output aria-label="system locale">{systemLocale}</output>
      <output aria-label="translation">{translate("설정")}</output>
      <button onClick={() => setPreference("en")} type="button">
        English
      </button>
      <button onClick={() => setPreference("system")} type="button">
        System
      </button>
    </div>
  );
}

function setBrowserLanguage(value: string) {
  Object.defineProperty(navigator, "language", { configurable: true, value });
}

describe("I18nProvider", () => {
  afterEach(() => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "ko");
    setBrowserLanguage("en-US");
  });

  it("system locale을 따르고 사용자 override를 즉시 저장·적용한다", () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "system");
    setBrowserLanguage("ko-KR");
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );

    expect(screen.getByLabelText("locale")).toHaveTextContent("ko");
    expect(screen.getByLabelText("translation")).toHaveTextContent("설정");
    expect(document.documentElement.lang).toBe("ko-KR");

    fireEvent.click(screen.getByRole("button", { name: "English" }));
    expect(screen.getByLabelText("locale")).toHaveTextContent("en");
    expect(screen.getByLabelText("translation")).toHaveTextContent("Settings");
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("en");
    expect(document.documentElement.lang).toBe("en-US");
  });

  it("system 모드에서 languagechange를 반영하고 미지원 locale은 영어로 폴백한다", () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "system");
    setBrowserLanguage("ko-KR");
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );

    setBrowserLanguage("ja-JP");
    act(() => window.dispatchEvent(new Event("languagechange")));
    expect(screen.getByLabelText("locale")).toHaveTextContent("en");
    expect(screen.getByLabelText("system locale")).toHaveTextContent("en");
  });

  it("override 중 변경된 system locale을 시스템 선택 즉시 사용한다", () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "en");
    setBrowserLanguage("en-US");
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );

    setBrowserLanguage("ko-KR");
    act(() => window.dispatchEvent(new Event("languagechange")));
    fireEvent.click(screen.getByRole("button", { name: "System" }));

    expect(screen.getByLabelText("preference")).toHaveTextContent("system");
    expect(screen.getByLabelText("system locale")).toHaveTextContent("ko");
    expect(screen.getByLabelText("locale")).toHaveTextContent("ko");
  });

  it("저장한 override가 재마운트 뒤 system locale보다 우선한다", () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "en");
    setBrowserLanguage("ko-KR");
    const first = render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByLabelText("locale")).toHaveTextContent("en");

    first.unmount();
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByLabelText("preference")).toHaveTextContent("en");
    expect(screen.getByLabelText("locale")).toHaveTextContent("en");
  });
});
