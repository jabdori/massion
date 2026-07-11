import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { api, consoleStore, liveConnection, sessionStore } from "../services.js";

export default function LoginPage() {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  async function submit(event: { preventDefault(): void }) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const session = await api.login(code.trim());
      sessionStore.authenticate(session);
      await navigate({ to: "/" });
      await consoleStore.load();
      liveConnection.start();
    } catch (cause) {
      if (sessionStore.getSnapshot().status === "authenticated") {
        consoleStore.setConnection("degraded");
      } else {
        setError(cause instanceof Error ? cause.message : "로그인에 실패했습니다");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-stage">
      <section className="login-ledger" aria-labelledby="login-title">
        <p className="eyebrow">MASSION / SECURE ENTRY</p>
        <h1 id="login-title">
          조직 운영실에
          <br />
          들어갑니다.
        </h1>
        <p className="login-copy">
          CLI에서 발급한 5분짜리 일회성 코드를 입력해주세요. 코드는 한 번만 사용되며, 브라우저에는 접근 토큰을 저장하지
          않습니다.
        </p>
        <form
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <label htmlFor="login-code">일회성 로그인 코드</label>
          <textarea
            id="login-code"
            name="code"
            rows={3}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
            }}
            placeholder="mwt_…"
            required
          />
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <button className="primary-button" type="submit" disabled={busy || code.trim().length === 0}>
            {busy ? "검증 중…" : "운영실 열기"}
          </button>
        </form>
      </section>
      <aside className="login-aside" aria-label="보안 안내">
        <span className="brand-mark large">M</span>
        <div className="security-rule">
          <b>01</b>
          <span>HttpOnly 조직 세션</span>
        </div>
        <div className="security-rule">
          <b>02</b>
          <span>요청마다 권한 재검증</span>
        </div>
        <div className="security-rule">
          <b>03</b>
          <span>변경 요청 위조 방지</span>
        </div>
      </aside>
    </main>
  );
}
