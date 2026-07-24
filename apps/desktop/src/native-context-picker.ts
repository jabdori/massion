import { open } from "@tauri-apps/plugin-dialog";

export interface NativeContextPicker {
  pickDirectory(): Promise<string | undefined>;
  pickFiles(): Promise<readonly string[]>;
}

export type DialogOpen = (options: { directory: boolean; multiple: boolean }) => Promise<string | string[] | null>;

export function createNativeContextPicker(dialogOpen: DialogOpen): NativeContextPicker {
  return {
    async pickDirectory() {
      const selected = await dialogOpen({ directory: true, multiple: false });
      return typeof selected === "string" ? selected : undefined;
    },
    async pickFiles() {
      const selected = await dialogOpen({ directory: false, multiple: true });
      return selected === null ? [] : typeof selected === "string" ? [selected] : selected;
    },
  };
}

export const nativeContextPicker = createNativeContextPicker(open);
