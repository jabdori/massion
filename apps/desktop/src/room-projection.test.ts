import type { RoomMessageViewV1 } from "@massion/application/client";
import { describe, expect, it } from "vitest";

import { projectRoomActivities, type OrganizationNodeView } from "@/desktop-service";

const nodes: OrganizationNodeView[] = [
  {
    id: "node-rep",
    handle: "representative",
    name: "Representative",
    responsibility: "사용자 요청 접수, 조정, 최종 응답",
    status: "active",
    role: "orchestrator",
    capabilities: ["request-coordination"],
  },
  {
    id: "node-evidence",
    handle: "evidence-research",
    name: "Evidence & Research",
    responsibility: "코드·문서·외부 근거 조사, 출처 검증",
    status: "active",
    role: "operator",
    capabilities: ["evidence-research"],
  },
  {
    id: "node-assurance",
    handle: "assurance",
    name: "Assurance",
    responsibility: "독립 리뷰, 테스트·보안·운영 검증",
    status: "active",
    role: "operator",
    capabilities: ["assurance"],
  },
];

function message(
  overrides: Partial<RoomMessageViewV1> & Pick<RoomMessageViewV1, "messageId" | "sequence">,
): RoomMessageViewV1 {
  return {
    messageType: "status",
    authorKind: "agent",
    authorId: "representative",
    content: "내용",
    createdAt: "2026-07-21T10:23:00.000Z",
    ...overrides,
  };
}

describe("협업방 투영", () => {
  it("sequence 순서로 정렬하고 화자를 정체성으로 세운다", () => {
    const activities = projectRoomActivities(
      [
        message({ messageId: "b", sequence: 2, messageType: "evidence", authorId: "evidence-research", content: "둘" }),
        message({ messageId: "a", sequence: 1, messageType: "evidence", authorId: "representative", content: "하나" }),
      ],
      nodes,
    );

    expect(activities.map((activity) => activity.id)).toEqual(["a", "b"]);
    const first = activities[0];
    expect(first?.kind).toBe("room");
    if (first?.kind === "room") {
      expect(first.speaker.name).toBe("Atlas");
      // 역할 배지는 조직 노드의 responsibility 첫 마디에서 옵니다.
      expect(first.speaker.role).toBe("사용자 요청 접수");
      expect(first.speaker.provisional).toBeUndefined();
    }
  });

  it("반론은 원본을 인용으로 물고 답변은 들여쓴다", () => {
    const activities = projectRoomActivities(
      [
        message({
          messageId: "q",
          sequence: 1,
          messageType: "question",
          authorId: "assurance",
          content: "기준이 뭔가요?",
        }),
        message({
          messageId: "a",
          sequence: 2,
          messageType: "answer",
          authorId: "evidence-research",
          content: "5축입니다.",
          replyToMessageId: "q",
        }),
        message({
          messageId: "c",
          sequence: 3,
          messageType: "challenge",
          authorId: "assurance",
          content: "비교가 성립하지 않습니다.",
          replyToMessageId: "a",
        }),
      ],
      nodes,
    );

    const answer = activities[1];
    if (answer?.kind !== "room") throw new Error("답변이 room 활동이 아닙니다");
    expect(answer.indented).toBe(true);

    const challenge = activities[2];
    if (challenge?.kind !== "room") throw new Error("반론이 room 활동이 아닙니다");
    // 반론은 무엇을 반박하는지 없이 존재할 수 없습니다.
    expect(challenge.quoted).toMatchObject({ author: "Quill", content: "5축입니다." });
  });

  it("계보가 없으면 인용도 들여쓰기도 만들지 않는다", () => {
    const activities = projectRoomActivities(
      [
        message({
          messageId: "c",
          sequence: 1,
          messageType: "challenge",
          authorId: "assurance",
          content: "반론만 있음",
        }),
      ],
      nodes,
    );

    const challenge = activities[0];
    if (challenge?.kind !== "room") throw new Error("반론이 room 활동이 아닙니다");
    expect(challenge.quoted).toBeUndefined();
  });

  it("인계는 다음 발언자를 받는 쪽으로 읽되 없으면 한쪽만 그린다", () => {
    const withReceiver = projectRoomActivities(
      [
        message({ messageId: "h", sequence: 1, messageType: "handoff", authorId: "evidence-research" }),
        message({ messageId: "n", sequence: 2, messageType: "evidence", authorId: "assurance" }),
      ],
      nodes,
    );
    const handoff = withReceiver[0];
    if (handoff?.kind !== "handoff") throw new Error("인계가 handoff 활동이 아닙니다");
    expect(handoff.from.name).toBe("Quill");
    expect(handoff.to?.name).toBe("Iris");

    const alone = projectRoomActivities(
      [message({ messageId: "h", sequence: 1, messageType: "handoff", authorId: "evidence-research" })],
      nodes,
    );
    const lonely = alone[0];
    if (lonely?.kind !== "handoff") throw new Error("인계가 handoff 활동이 아닙니다");
    // 받는 쪽은 도메인에 없습니다. 모르면 지어내지 않습니다.
    expect(lonely.to).toBeUndefined();
  });

  it("조직 그래프에 없는 화자는 미승인으로 표기한다", () => {
    const activities = projectRoomActivities(
      [message({ messageId: "m", sequence: 1, messageType: "evidence", authorId: "quant-analysis" })],
      nodes,
    );
    const activity = activities[0];
    if (activity?.kind !== "room") throw new Error("활동이 room이 아닙니다");
    // scope:"work" 노드이거나 아직 승인되지 않은 노드입니다. 점선으로 표기됩니다.
    expect(activity.speaker.provisional).toBe(true);
    expect(activity.speaker.role).toBe("quant-analysis");
  });

  it("status는 발언이 아니므로 아바타 없는 줄이 된다", () => {
    const activities = projectRoomActivities(
      [message({ messageId: "s", sequence: 1, messageType: "status", content: "라운드 4 / 12" })],
      nodes,
    );
    expect(activities[0]).toMatchObject({ kind: "roomStatus", content: "라운드 4 / 12" });
  });

  it("사람 참가자는 색 슬롯을 쓰지 않는다", () => {
    const activities = projectRoomActivities(
      [message({ messageId: "u", sequence: 1, messageType: "question", authorKind: "user", authorId: "owner-1" })],
      nodes,
    );
    const activity = activities[0];
    if (activity?.kind !== "room") throw new Error("활동이 room이 아닙니다");
    expect(activity.speaker.human).toBe(true);
    expect(activity.speaker.accentSlot).toBeLessThan(0);
  });
});
