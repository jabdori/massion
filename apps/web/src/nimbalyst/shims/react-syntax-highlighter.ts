// react-syntax-highlighter 가벼운 shim.
// @ts-nocheck — react-syntax-highlighter ESM 서브경로에 타입 선언이 없어 임시 nocheck.
// vite alias 가 이 모듈을 "react-syntax-highlighter" 로 가로챈다.
// 원본은 Prism(전체 언어 277개, 636KB)을 끌어당겨 청크 예산을 초과한다.
// PrismLight + transcript에서 실제 쓰는 언어만 등록해 번들을 1/10 이하로 줄인다.
import SyntaxHighlighter from "react-syntax-highlighter/dist/esm/prism-light.js";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx.js";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx.js";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript.js";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript.js";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash.js";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json.js";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css.js";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml.js";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown.js";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql.js";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python.js";
import go from "react-syntax-highlighter/dist/esm/languages/prism/go.js";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust.js";
import diff from "react-syntax-highlighter/dist/esm/languages/prism/diff.js";

SyntaxHighlighter.registerLanguage("jsx", jsx);
SyntaxHighlighter.registerLanguage("tsx", tsx);
SyntaxHighlighter.registerLanguage("typescript", tsx);
SyntaxHighlighter.registerLanguage("ts", typescript);
SyntaxHighlighter.registerLanguage("javascript", javascript);
SyntaxHighlighter.registerLanguage("js", javascript);
SyntaxHighlighter.registerLanguage("bash", bash);
SyntaxHighlighter.registerLanguage("sh", bash);
SyntaxHighlighter.registerLanguage("shell", bash);
SyntaxHighlighter.registerLanguage("json", json);
SyntaxHighlighter.registerLanguage("css", css);
SyntaxHighlighter.registerLanguage("yaml", yaml);
SyntaxHighlighter.registerLanguage("yml", yaml);
SyntaxHighlighter.registerLanguage("markdown", markdown);
SyntaxHighlighter.registerLanguage("md", markdown);
SyntaxHighlighter.registerLanguage("sql", sql);
SyntaxHighlighter.registerLanguage("python", python);
SyntaxHighlighter.registerLanguage("py", python);
SyntaxHighlighter.registerLanguage("go", go);
SyntaxHighlighter.registerLanguage("rust", rust);
SyntaxHighlighter.registerLanguage("rs", rust);
SyntaxHighlighter.registerLanguage("diff", diff);

export const Prism = SyntaxHighlighter;
export default SyntaxHighlighter;
