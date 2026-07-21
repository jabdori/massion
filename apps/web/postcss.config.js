// nimbalyst 디자인 시스템(vendor/nimbalyst)을 위한 tailwind 도입.
// preflight는 기존 순수 CSS reset과 충돌하지 않도록 tailwind.config에서 끕니다.
export default {
  plugins: {
    tailwindcss: { config: "./tailwind.config.ts" },
    autoprefixer: {},
  },
};
