// react-syntax-highlighter ESM 서브경로에 대한 ambient 타입(원본에 타입 선언 없음).
declare module "react-syntax-highlighter/dist/esm/prism-light.js" {
  import type { ComponentType } from "react";
  interface RshProps {
    readonly language?: string;
    readonly style?: unknown;
    readonly customStyle?: Record<string, unknown>;
    readonly PreTag?: string | ComponentType<unknown>;
    readonly codeTagProps?: Record<string, unknown>;
    readonly children?: string;
  }
  export const PrismLight: ComponentType<RshProps> & {
    registerLanguage: (name: string, syntax: unknown) => void;
  };
}
declare module "react-syntax-highlighter/dist/esm/languages/prism/jsx.js" {
  const syntax: (compiler: unknown) => void;
  export default syntax;
}
declare module "react-syntax-highlighter/dist/esm/languages/prism/tsx.js" {
  const syntax: (compiler: unknown) => void;
  export default syntax;
}
declare module "react-syntax-highlighter/dist/esm/languages/prism/typescript.js" {
  const syntax: (compiler: unknown) => void;
  export default syntax;
}
declare module "react-syntax-highlighter/dist/esm/languages/prism/javascript.js" {
  const syntax: (compiler: unknown) => void;
  export default syntax;
}
declare module "react-syntax-highlighter/dist/esm/languages/prism/bash.js" {
  const syntax: (compiler: unknown) => void;
  export default syntax;
}
declare module "react-syntax-highlighter/dist/esm/languages/prism/json.js" {
  const syntax: (compiler: unknown) => void;
  export default syntax;
}
declare module "react-syntax-highlighter/dist/esm/languages/prism/css.js" {
  const syntax: (compiler: unknown) => void;
  export default syntax;
}
declare module "react-syntax-highlighter/dist/esm/languages/prism/yaml.js" {
  const syntax: (compiler: unknown) => void;
  export default syntax;
}
declare module "react-syntax-highlighter/dist/esm/languages/prism/markdown.js" {
  const syntax: (compiler: unknown) => void;
  export default syntax;
}
declare module "react-syntax-highlighter/dist/esm/languages/prism/sql.js" {
  const syntax: (compiler: unknown) => void;
  export default syntax;
}
declare module "react-syntax-highlighter/dist/esm/languages/prism/python.js" {
  const syntax: (compiler: unknown) => void;
  export default syntax;
}
declare module "react-syntax-highlighter/dist/esm/languages/prism/go.js" {
  const syntax: (compiler: unknown) => void;
  export default syntax;
}
declare module "react-syntax-highlighter/dist/esm/languages/prism/rust.js" {
  const syntax: (compiler: unknown) => void;
  export default syntax;
}
declare module "react-syntax-highlighter/dist/esm/languages/prism/diff.js" {
  const syntax: (compiler: unknown) => void;
  export default syntax;
}
