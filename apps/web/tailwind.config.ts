// Massion Web Tailwind 설정 — nimbalyst 렌더러(vendor/nimbalyst) 시각 시스템용.
// content는 vendor/신규 화면으로 제한, preflight=false 로 기존 reset 보존, 색상은 --nim-* 변수 위임.
import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/vendor/nimbalyst/**/*.{ts,tsx}", "./src/nimbalyst/**/*.{ts,tsx}"],
  darkMode: ["variant", '&:is([data-theme="dark"] *, [data-theme="crystal-dark"] *)'],
  corePlugins: { preflight: false },
  theme: {
    extend: {
      colors: {
        nim: {
          DEFAULT: "var(--nim-bg)",
          secondary: "var(--nim-bg-secondary)",
          tertiary: "var(--nim-bg-tertiary)",
          hover: "var(--nim-bg-hover)",
          selected: "var(--nim-bg-selected)",
          active: "var(--nim-bg-active)",
        },
        "nim-text": {
          DEFAULT: "var(--nim-text)",
          muted: "var(--nim-text-muted)",
          faint: "var(--nim-text-faint)",
          disabled: "var(--nim-text-disabled)",
        },
        "nim-border": {
          DEFAULT: "var(--nim-border)",
          focus: "var(--nim-border-focus)",
        },
        "nim-primary": {
          DEFAULT: "var(--nim-primary)",
          hover: "var(--nim-primary-hover)",
        },
        "nim-on-primary": "var(--nim-on-primary)",
        "nim-link": { DEFAULT: "var(--nim-link)", hover: "var(--nim-link-hover)" },
        "nim-success": "var(--nim-success)",
        "nim-warning": "var(--nim-warning)",
        "nim-error": "var(--nim-error)",
        "nim-info": "var(--nim-info)",
      },
    },
  },
  plugins: [],
};

export default config;
