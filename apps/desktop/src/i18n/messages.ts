import { appEnglishMessages } from "./messages-app";
import { sharedEnglishMessages } from "./messages-shared";

export const englishMessages: Readonly<Record<string, string>> = {
  ...appEnglishMessages,
  ...sharedEnglishMessages,
};
