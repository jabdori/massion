import { describe, expect, it, vi } from "vitest";

import { fetchMiniMaxQuota } from "./minimax-quota.js";

describe("MiniMax Token Plan 할당량 직접 조회", () => {
  it("공식 endpoint의 사용량 count를 남은 5시간·주간 window로 변환한다", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          base_resp: { status_code: 0, status_msg: "success" },
          model_remains: [
            {
              model_name: "MiniMax-M2.7",
              current_interval_total_count: 1_500,
              current_interval_usage_count: 300,
              current_weekly_total_count: 10_000,
              current_weekly_usage_count: 2_500,
              remains_time: 1_000,
              weekly_remains_time: 2_000,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(
      fetchMiniMaxQuota("sk-cp-secret", {
        fetcher,
        now: () => new Date("2026-07-12T00:00:00.000Z"),
      }),
    ).resolves.toEqual([
      {
        kind: "session-5h",
        limit: 1_500,
        remaining: 1_200,
        remainingRatio: 0.8,
        resetsAt: "2026-07-12T00:00:01.000Z",
        observedAt: "2026-07-12T00:00:00.000Z",
        source: "minimax-token-plan-endpoint",
        confidence: "reported",
      },
      {
        kind: "weekly-7d",
        limit: 10_000,
        remaining: 7_500,
        remainingRatio: 0.75,
        resetsAt: "2026-07-12T00:00:02.000Z",
        observedAt: "2026-07-12T00:00:00.000Z",
        source: "minimax-token-plan-endpoint",
        confidence: "reported",
      },
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      "https://www.minimax.io/v1/token_plan/remains",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        cache: "no-store",
        headers: expect.objectContaining({ Authorization: "Bearer sk-cp-secret" }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("실계정 Coding Plan 응답의 general 백분율 window를 허위 count 없이 보존한다", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          base_resp: { status_code: 0, status_msg: "success" },
          model_remains: [
            {
              model_name: "general",
              current_interval_total_count: 0,
              current_interval_usage_count: 0,
              current_weekly_total_count: 0,
              current_weekly_usage_count: 0,
              current_interval_remaining_percent: 99,
              current_weekly_remaining_percent: 42,
              remains_time: 13_815_408,
              weekly_remains_time: 427_670_466,
            },
            {
              model_name: "video",
              current_interval_remaining_percent: 1,
              current_weekly_remaining_percent: 1,
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const windows = await fetchMiniMaxQuota("sk-cp-secret", {
      fetcher,
      now: () => new Date("2026-07-12T00:00:00.000Z"),
    });

    expect(windows).toEqual([
      expect.objectContaining({ kind: "session-5h", remainingRatio: 0.99 }),
      expect.objectContaining({ kind: "weekly-7d", remainingRatio: 0.42 }),
    ]);
    expect(windows[0]).not.toHaveProperty("limit");
    expect(windows[0]).not.toHaveProperty("remaining");
  });

  it("인증 실패·알 수 없는 응답·과대 응답을 비밀값 없이 닫힌 실패로 처리한다", async () => {
    const secret = "sk-cp-do-not-leak";
    const cases = [
      new Response(JSON.stringify({ error: secret }), { status: 401 }),
      new Response(JSON.stringify({ base_resp: { status_code: 0 }, model_remains: [] }), { status: 200 }),
      new Response("x".repeat(262_145), { status: 200 }),
    ];

    for (const response of cases) {
      const error = await fetchMiniMaxQuota(secret, {
        fetcher: vi.fn().mockResolvedValue(response),
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain('error"');
    }
  });

  it("HTTP 200 안의 공식 인증 오류 코드 1004도 재인증 필요로 분류한다", async () => {
    const error = await fetchMiniMaxQuota("sk-cp-secret", {
      fetcher: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ base_resp: { status_code: 1004, status_msg: "token invalid" } }), {
          status: 200,
        }),
      ),
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ category: "authentication" });
  });
});
