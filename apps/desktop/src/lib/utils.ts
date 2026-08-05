type StaticClassName = string | false | null | undefined;
type StatefulClassName<State> = StaticClassName | ((state: State) => StaticClassName);

/**
 * 이 cn은 tailwind-merge가 아니라 단순 이어붙이기입니다. 충돌하는 유틸리티는 해소되지 않고
 * 스타일시트 방출 순서가 승자를 정하므로, 컴포넌트 base 클래스는 className으로 덮을 수 없습니다.
 * 시각을 바꾸려면 컴포넌트의 base를 직접 고치십시오.
 */
function joinClassNames(classes: readonly StaticClassName[]): string {
  return classes.filter(Boolean).join(" ");
}

export function cn(...classes: readonly StaticClassName[]): string;
export function cn<State>(...classes: readonly StatefulClassName<State>[]): string | ((state: State) => string);
export function cn<State>(...classes: readonly StatefulClassName<State>[]): string | ((state: State) => string) {
  const callbacks = classes.filter((value): value is (state: State) => StaticClassName => typeof value === "function");
  const staticClasses = classes.filter((value): value is StaticClassName => typeof value !== "function");

  if (callbacks.length === 0) return joinClassNames(staticClasses);
  return (state) => joinClassNames([...staticClasses, ...callbacks.map((callback) => callback(state))]);
}
