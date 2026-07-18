export class PromptCancelledError extends Error {
  constructor() {
    super("대화형 입력을 취소했습니다");
    this.name = "PromptCancelledError";
  }
}
