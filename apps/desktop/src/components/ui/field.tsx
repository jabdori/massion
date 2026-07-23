import * as React from "react";

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface FieldState {
  readonly id: string;
  readonly invalid: boolean;
  readonly descriptionId: string;
  readonly errorId: string;
}

const FieldContext = React.createContext<FieldState | undefined>(undefined);

function useFieldState(): FieldState {
  const state = React.useContext(FieldContext);
  if (!state) throw new Error("Field 하위 구성요소는 Field 안에서 사용해야 합니다");
  return state;
}

function Field({
  id,
  invalid = false,
  className,
  ...props
}: React.ComponentProps<"div"> & { id?: string; invalid?: boolean }) {
  const generatedId = React.useId();
  const fieldId = id ?? generatedId;
  const state = React.useMemo<FieldState>(
    () => ({
      id: fieldId,
      invalid,
      descriptionId: `${fieldId}-description`,
      errorId: `${fieldId}-error`,
    }),
    [fieldId, invalid],
  );

  return (
    <FieldContext.Provider value={state}>
      <div data-slot="field" data-invalid={invalid || undefined} className={cn("grid gap-2", className)} {...props} />
    </FieldContext.Provider>
  );
}

function FieldLabel({ className, ...props }: React.ComponentProps<typeof Label>) {
  const { id } = useFieldState();
  return <Label data-slot="field-label" className={cn("text-primary", className)} htmlFor={id} {...props} />;
}

function FieldControl({ children }: { children: React.ReactElement }) {
  const { id, invalid, descriptionId, errorId } = useFieldState();
  const control = children as React.ReactElement<Record<string, unknown>>;
  const describedBy = [
    typeof control.props["aria-describedby"] === "string" ? control.props["aria-describedby"] : undefined,
    descriptionId,
    ...(invalid ? [errorId] : []),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  return React.cloneElement(control, {
    id,
    "aria-describedby": describedBy,
    "aria-invalid": invalid || undefined,
  });
}

function FieldDescription({ className, ...props }: React.ComponentProps<"p">) {
  const { descriptionId } = useFieldState();
  return (
    <p
      data-slot="field-description"
      id={descriptionId}
      className={cn("text-xs leading-5 text-muted-foreground", className)}
      {...props}
    />
  );
}

function FieldError({ className, ...props }: React.ComponentProps<"p">) {
  const { errorId } = useFieldState();
  return (
    <p
      data-slot="field-error"
      id={errorId}
      role="alert"
      className={cn("text-xs leading-5 text-destructive", className)}
      {...props}
    />
  );
}

export { Field, FieldControl, FieldDescription, FieldError, FieldLabel };
