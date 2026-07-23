import { describe, expect, it } from "vitest";

import styles from "./styles.css?raw";

function hex(css: string, token: string): string {
  const found = new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  if (!found?.[1]) throw new Error(`${token} 토큰을 찾지 못했습니다`);
  return found[1];
}

function luminance(value: string): number {
  const channel = (raw: number): number => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const n = Number.parseInt(value.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((left, right) => right - left) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

describe("스타일 의미 토큰", () => {
  it("캔버스를 배경 색상으로 노출합니다", () => {
    expect(styles).toContain("--color-background: var(--canvas);");
  });

  it("사이드바 색상 토큰을 노출합니다", () => {
    expect(styles).toMatch(/--color-sidebar:\s*var\(--[\w-]+\);/);
  });

  it("화자 색 슬롯 8개를 노출합니다", () => {
    // 슬롯은 역할이 아니라 handle에 배정됩니다. 역할에 붙이면 같은 역할이 병렬로 돌 때 색이 겹칩니다.
    for (let slot = 0; slot < 8; slot += 1) {
      expect(styles).toContain(`--agent-${String(slot)}: #`);
      expect(styles).toContain(`--color-agent-${String(slot)}: var(--agent-${String(slot)});`);
    }
  });

  it("화자 색에 노랑·초록 계열을 넣지 않습니다", () => {
    // 노랑은 "사람이 필요함" 예약어이고, 초록은 성공 표시로 오독됩니다.
    const slots = [...styles.matchAll(/--agent-[0-7]: (#[0-9a-f]{6});/g)].map((match) => match[1] ?? "");
    expect(slots).toHaveLength(8);
    for (const hex of slots) {
      const red = Number.parseInt(hex.slice(1, 3), 16);
      const green = Number.parseInt(hex.slice(3, 5), 16);
      const blue = Number.parseInt(hex.slice(5, 7), 16);
      const yellowish = red > blue + 40 && green > blue + 40;
      const greenish = green > red + 40 && green > blue + 40;
      expect(`${hex} yellow=${String(yellowish)} green=${String(greenish)}`).toBe(`${hex} yellow=false green=false`);
    }
  });

  it("초점 표시에 gate를 쓰지 않습니다", () => {
    // 노랑은 "사람이 필요함" 전용어입니다. 초점 링이 노랑이면 예약어가 무의미해집니다.
    expect(styles).toMatch(/--focus-ring:\s*var\(--agent-strategy\);/);
  });

  it("메타 텍스트가 WCAG AA 대비를 넘습니다", () => {
    // fg-3는 11px 시각·checksum·경로에 쓰므로 소형 텍스트 기준 4.5:1을 넘겨야 합니다.
    // bg-3는 nav 활성 배경과 진행바 트랙이라 메타 텍스트가 얹히지 않습니다.
    const bg = hex(styles, "--bg-0");
    for (const surface of ["--bg-0", "--bg-1", "--bg-2"]) {
      expect(`${surface} ${contrast(hex(styles, "--fg-3"), hex(styles, surface)).toFixed(2)}`).toBe(
        `${surface} ${Math.max(4.5, contrast(hex(styles, "--fg-3"), hex(styles, surface))).toFixed(2)}`,
      );
    }
    expect(contrast(hex(styles, "--fg-2"), bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(hex(styles, "--fg"), bg)).toBeGreaterThanOrEqual(7);
  });

  it("그림자를 쓰지 않으므로 면과 선이 실제로 보여야 합니다", () => {
    // 깊이는 층위와 1px 선이 전부입니다. 분리가 1.05였을 때는 카드가 배경과 붙어 보였습니다.
    expect(contrast(hex(styles, "--bg-1"), hex(styles, "--bg-0"))).toBeGreaterThanOrEqual(1.08);
    expect(contrast(hex(styles, "--bg-2"), hex(styles, "--bg-0"))).toBeGreaterThanOrEqual(1.15);
    expect(contrast(hex(styles, "--line"), hex(styles, "--bg-0"))).toBeGreaterThanOrEqual(1.4);
  });

  it("scope work·미승인 표기를 점선 토큰 하나로 고정합니다", () => {
    expect(styles).toMatch(/--provisional-border:\s*1px dashed var\(--agent-provisional\);/);
  });
});
