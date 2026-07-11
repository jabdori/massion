import { describe, expect, it } from "vitest";

import { parseCliArguments } from "./parser.js";

describe("mass CLI parser", () => {
  it.each([
    [["init"], "init", undefined],
    [["status", "--json"], "status", undefined],
    [["run", "제품화", "--wait"], "run", undefined],
    [["watch", "--events", "jsonl", "--after", "12"], "watch", undefined],
    [["org", "graph"], "org", "graph"],
    [["work", "follow-up", "work-1", "추가 작업"], "work", "follow-up"],
    [["chat", "send", "room-1", "안녕하세요"], "chat", "send"],
    [["task", "assign", "task-1", "agent-1"], "task", "assign"],
    [["approval", "approve", "approval-1"], "approval", "approve"],
    [["runtime", "suspend", "execution-1"], "runtime", "suspend"],
    [["provider", "route-set"], "provider", "route-set"],
    [["ext", "install", "extension.tgz"], "ext", "install"],
    [["ext", "search", "slack"], "ext", "search"],
    [["ext", "inventory"], "ext", "inventory"],
    [["growth", "suggestions"], "growth", "suggestions"],
    [["doctor"], "doctor", undefined],
  ])("%j를 해석한다", (argv, command, subcommand) => {
    expect(parseCliArguments(argv)).toMatchObject({ command, ...(subcommand === undefined ? {} : { subcommand }) });
  });

  it("출력·대기 상호 배타 flag와 typo·불완전 option을 거부한다", () => {
    expect(() => parseCliArguments(["run", "요청", "--detach", "--wait"])).toThrow("동시에");
    expect(() => parseCliArguments(["status", "--json", "--jsonl"])).toThrow("동시에");
    expect(() => parseCliArguments(["statsu"])).toThrow("지원하지 않는");
    expect(() => parseCliArguments(["watch", "--after"])).toThrow("값");
  });

  it("token 원문 command-line flag를 제공하지 않는다", () => {
    expect(() => parseCliArguments(["status", "--token", "secret"])).toThrow("지원하지 않는 option");
  });
});
