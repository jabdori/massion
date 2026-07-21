// nimbalyst vendor 모듈 타입 shim
// 메인 tsconfig(strict, NodeNext)는 vendor 소스를 직접 검사하지 않습니다.
// wrapper 컴포넌트들이 @nimbalyst/* import를 type 수준에서 any로 해결하여
// vendor 전체가 strict 프로그램으로 끌려들어오는 것을 막습니다.
// 빌드(vite) 시에는 alias가 실제 vendor 소스로 연결합니다.
declare module "@nimbalyst/runtime";
declare module "@nimbalyst/runtime/*";
declare module "@nimbalyst/extension-sdk";
declare module "@nimbalyst/extension-sdk/*";
declare module "@nimbalyst/collab-protocol";
declare module "@nimbalyst/collab-adapters";
