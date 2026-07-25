type StaticClassName = string | false | null | undefined;
type StatefulClassName<State> = StaticClassName | ((state: State) => StaticClassName);

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
