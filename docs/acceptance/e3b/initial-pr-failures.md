## B1 (dark)

```text
  FAIL  missing header       link     "사이드바 보기"
  FAIL  missing composer     textbox  "답변을 입력하거나 다른 이야기를 하세요"
  FAIL  budget composer     chars 37 > 27
FAIL: 3 failures, 0 warnings, 11 required elements
```

## B2 (dark)

```text
  FAIL  missing sidebar      status   "실행 중"
  FAIL  order  sidebar      link     "{member}" (occurrence already consumed or found earlier)
  FAIL  missing conversation link     "사례 보기"
  FAIL  order  conversation button   "복사" (occurrence already consumed or found earlier)
  FAIL  order  conversation button   "복사" (occurrence already consumed or found earlier)
  FAIL  order  conversation text     "{date}" (occurrence already consumed or found earlier)
  FAIL  missing conversation link     "{work_title} 실행 중 퀼 {duration} 조사 분류 요약 확인 {progress} · 나누기 완료 · 원인 정리 중"
  FAIL  budget sidebar      sentences 1 > 0: "활동 보기, 확인 필요"
  FAIL  budget composer     chars 37 > 27
FAIL: 9 failures, 0 warnings, 31 required elements
```

## B2-offline (dark)

```text
  FAIL  role   sidebar      switch   "활동 보기" (text exists without the required role)
  FAIL  missing sidebar      status   "실행 중"
  FAIL  order  sidebar      link     "{member}" (occurrence already consumed or found earlier)
  FAIL  budget sidebar      sentences 1 > 0: "활동 보기, 확인 필요"
FAIL: 4 failures, 2 warnings, 20 required elements
```

## B2-offline-failed (dark)

```text
  FAIL  role   sidebar      switch   "활동 보기" (text exists without the required role)
  FAIL  missing sidebar      status   "실행 중"
  FAIL  order  sidebar      link     "{member}" (occurrence already consumed or found earlier)
  FAIL  missing composer     status   "보내지 못함 · 다시 보내기"
  FAIL  budget sidebar      sentences 1 > 0: "활동 보기, 확인 필요"
FAIL: 5 failures, 2 warnings, 22 required elements
```

## B3 (dark)

```text
  FAIL  missing sidebar      status   "실행 중"
  FAIL  order  sidebar      link     "{member}" (occurrence already consumed or found earlier)
  FAIL  missing conversation link     "반올림 규칙"
  FAIL  budget composer     chars 37 > 27
FAIL: 4 failures, 1 warnings, 22 required elements
```

## B3-run (dark)

```text
  FAIL  missing sidebar      status   "실행 중"
  FAIL  order  sidebar      link     "{member}" (occurrence already consumed or found earlier)
  FAIL  missing conversation link     "반올림 규칙"
  FAIL  missing conversation link     "{work_title} 실행 중 퀼 {duration} 조사 분류 요약 확인 {progress} · 나누기 완료 · 원인 정리 중"
  FAIL  budget composer     chars 37 > 27
FAIL: 5 failures, 1 warnings, 23 required elements
```

## B4 (dark)

```text
  FAIL  order  rail         button   "내 계정" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "결정 대기"
  FAIL  order  sidebar      status   "작업 중" (occurrence already consumed or found earlier)
  FAIL  order  sidebar      link     "{work_title}" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "실행 중"
  FAIL  order  sidebar      link     "{work_title}" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "확인 대기"
  FAIL  order  sidebar      link     "{member}" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "읽지 않음"
  FAIL  missing conversation button   "{duration} 동안 작업 · 페이지 {count} 읽음"
  FAIL  missing pane         link     "작업 공간 닫기"
  FAIL  region pane         text     "{amount}" (found in conversation)
  FAIL  region pane         text     "{amount}" (found in conversation)
  FAIL  region pane         text     "{amount}" (found in conversation)
  FAIL  budget sidebar      sentences 1 > 0: "활동 보기, 확인 필요"
  FAIL  budget composer     chars 37 > 27
  FAIL  budget pane         sentences 2 > 0: "기존 차단 유지 · 취소해도 외부 실행은 되돌려지지 않습니다"
  FAIL  budget pane         longest string 33 > 24 chars
  FAIL  budget pane         chars 730 > 203
FAIL: 19 failures, 0 warnings, 35 required elements
```

## B5 (dark)

```text
  FAIL  order  rail         button   "내 계정" (occurrence already consumed or found earlier)
  FAIL  missing header       link     "사이드바 보기"
  FAIL  missing header       link     "작업 공간"
  FAIL  missing conversation button   "{duration} 동안 작업 · 페이지 {count} 읽음"
  FAIL  missing conversation button   "주문 내역 확인"
  FAIL  missing conversation button   "닫기"
  FAIL  budget composer     chars 37 > 27
FAIL: 7 failures, 0 warnings, 17 required elements
```

## B6 (dark)

```text
  FAIL  order  rail         button   "내 계정" (occurrence already consumed or found earlier)
  FAIL  role   sidebar      switch   "활동 보기" (text exists without the required role)
  FAIL  missing sidebar      status   "작업 중"
  FAIL  region sidebar      status   "실패" (found in conversation)
  FAIL  order  sidebar      link     "{work_title}" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "확인 대기"
  FAIL  order  sidebar      link     "{member}" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "읽지 않음"
  FAIL  missing header       link     "작업 공간"
  FAIL  missing conversation link     "{work_title} 실패 {time} – {time} 조사 분류 요약 확인 확인 실패 · 근거 {count}"
  FAIL  missing conversation link     "방향 바꿈: {work_title} · {time}"
  FAIL  order  conversation button   "복사" (occurrence already consumed or found earlier)
  FAIL  missing conversation link     "{work_title} 확인 대기 {duration} 조사 표 정리 확인 표 {count} · 확인 대기"
  FAIL  missing conversation button   "남기기"
  FAIL  missing conversation button   "지우기"
  FAIL  order  conversation button   "복사" (occurrence already consumed or found earlier)
  FAIL  missing composer     textbox  "퀼에게 메시지 보내기"
  FAIL  budget sidebar      sentences 1 > 0: "활동 보기, 확인 필요"
  FAIL  budget composer     chars 37 > 27
FAIL: 19 failures, 1 warnings, 34 required elements
```

## B6-token (dark)

```text
  FAIL  order  rail         button   "내 계정" (occurrence already consumed or found earlier)
  FAIL  role   sidebar      switch   "활동 보기" (text exists without the required role)
  FAIL  missing sidebar      status   "작업 중"
  FAIL  missing sidebar      status   "실행 중"
  FAIL  order  sidebar      link     "{work_title}" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "실행 중"
  FAIL  order  sidebar      link     "{member}" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "작업 중"
  FAIL  order  sidebar      link     "{work_title}" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "실행 중"
  FAIL  missing header       link     "작업 공간"
  FAIL  budget sidebar      sentences 1 > 0: "활동 보기, 확인 필요"
  FAIL  budget composer     chars 37 > 27
FAIL: 13 failures, 3 warnings, 28 required elements
```

## B11 (dark)

```text
  FAIL  role   sidebar      switch   "활동 보기" (text exists without the required role)
  FAIL  order  page         option   "Enter" (occurrence already consumed or found earlier)
  FAIL  order  page         option   "{member}" (occurrence already consumed or found earlier)
  FAIL  order  page         link     "구성원 관리" (occurrence already consumed or found earlier)
  FAIL  order  page         button   "복사" (occurrence already consumed or found earlier)
  FAIL  budget sidebar      sentences 1 > 0: "활동 보기, 확인 필요"
  FAIL  budget sidebar      chars 31 > 25
FAIL: 7 failures, 2 warnings, 22 required elements
```

## B11-quill (dark)

```text
  FAIL  role   sidebar      switch   "활동 보기" (text exists without the required role)
  FAIL  budget sidebar      sentences 1 > 0: "활동 보기, 확인 필요"
  FAIL  budget sidebar      chars 31 > 25
  FAIL  budget composer     chars 37 > 27
FAIL: 4 failures, 2 warnings, 17 required elements
```

## B16 (dark)

```text
  FAIL  missing sidebar      button   "우선순위"
  FAIL  missing sidebar      link     "깨지는 테스트 고치기 노트북의 Claude Code에게 처음 맡길까요?"
  FAIL  missing sidebar      link     "반올림 규칙 바꾸기 합계에서 한 번 반올림으로 바꿀까요? 지금 규칙 {progress}, 새 규칙 {progress}."
  FAIL  missing sidebar      status   "읽지 않음"
  FAIL  budget composer     chars 37 > 27
FAIL: 5 failures, 0 warnings, 22 required elements
```

## B16-later (dark)

```text
  FAIL  missing sidebar      button   "우선순위"
  FAIL  missing sidebar      link     "반올림 규칙 바꾸기 합계에서 한 번 반올림으로 바꿀까요? 지금 규칙 {progress}, 새 규칙 {progress}."
  FAIL  missing sidebar      status   "읽지 않음"
  FAIL  order  conversation button   "복사" (occurrence already consumed or found earlier)
  FAIL  budget composer     chars 37 > 27
FAIL: 5 failures, 0 warnings, 21 required elements
```

## B16-sent (dark)

```text
  FAIL  missing sidebar      button   "우선순위"
  FAIL  missing sidebar      link     "반올림 규칙 바꾸기 합계에서 한 번 반올림으로 바꿀까요? 지금 규칙 {progress}, 새 규칙 {progress}."
  FAIL  missing sidebar      status   "읽지 않음"
  FAIL  missing sidebar      link     "깨지는 테스트 고치기 09:13에 보냈어요. 응답 대기예요."
  FAIL  order  conversation button   "복사" (occurrence already consumed or found earlier)
  FAIL  budget composer     chars 37 > 27
FAIL: 6 failures, 1 warnings, 21 required elements
```

## B18 (dark)

```text
  FAIL  order  rail         button   "내 계정" (occurrence already consumed or found earlier)
  FAIL  role   sidebar      switch   "활동 보기" (text exists without the required role)
  FAIL  missing sidebar      status   "실행 중"
  FAIL  order  sidebar      link     "{work_title}" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "확인 대기"
  FAIL  order  sidebar      link     "{member}" (occurrence already consumed or found earlier)
  FAIL  order  sidebar      status   "작업 중" (occurrence already consumed or found earlier)
  FAIL  order  sidebar      link     "{work_title}" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "실행 중"
  FAIL  missing header       link     "작업 공간"
  FAIL  missing conversation link     "{work_title} 실행 중 {duration} 조사 분류 요약 확인 나누기 완료 · 원인 정리 중"
  FAIL  missing conversation link     "방향 바꿈: {work_title} · {time}"
  FAIL  missing conversation link     "{work_title} 확인 대기 {duration} 조사 표 정리 확인 표 {count} · 확인 대기"
  FAIL  missing conversation button   "남기기"
  FAIL  missing conversation button   "지우기"
  FAIL  budget sidebar      sentences 1 > 0: "활동 보기, 확인 필요"
  FAIL  budget composer     chars 36 > 27
FAIL: 17 failures, 2 warnings, 34 required elements
```

## B21 (dark)

```text
  FAIL  missing sidebar      status   "작업 중"
  FAIL  missing sidebar      status   "실행 중"
  FAIL  order  sidebar      link     "{member}" (occurrence already consumed or found earlier)
  FAIL  budget sidebar      sentences 1 > 0: "활동 보기, 확인 필요"
  FAIL  budget composer     chars 37 > 27
FAIL: 5 failures, 1 warnings, 21 required elements
```

## B21-name (dark)

```text
  FAIL  missing sidebar      status   "작업 중"
  FAIL  missing sidebar      status   "실행 중"
  FAIL  order  sidebar      link     "{member}" (occurrence already consumed or found earlier)
  FAIL  role   dialog:새 구성원 만들기 button   "동그라미" (text exists without the required role)
  FAIL  role   dialog:새 구성원 만들기 button   "네모" (text exists without the required role)
  FAIL  role   dialog:새 구성원 만들기 button   "물방울" (text exists without the required role)
  FAIL  role   dialog:새 구성원 만들기 button   "육각" (text exists without the required role)
  FAIL  role   dialog:새 구성원 만들기 button   "마름모" (text exists without the required role)
  FAIL  role   dialog:새 구성원 만들기 button   "구름" (text exists without the required role)
  FAIL  role   dialog:새 구성원 만들기 button   "세 잎" (text exists without the required role)
  FAIL  role   dialog:새 구성원 만들기 button   "세모" (text exists without the required role)
  FAIL  budget sidebar      sentences 1 > 0: "활동 보기, 확인 필요"
  FAIL  budget composer     chars 37 > 27
FAIL: 13 failures, 2 warnings, 33 required elements
```

## B21-done (dark)

```text
  FAIL  missing sidebar      status   "작업 중"
  FAIL  missing sidebar      status   "실행 중"
  FAIL  order  sidebar      link     "{member}" (occurrence already consumed or found earlier)
  FAIL  budget composer     chars 36 > 27
FAIL: 4 failures, 1 warnings, 20 required elements
```

## B21-done-hana (dark)

```text
  FAIL  missing sidebar      status   "작업 중"
  FAIL  missing sidebar      status   "실행 중"
  FAIL  order  sidebar      link     "{member}" (occurrence already consumed or found earlier)
  FAIL  missing conversation link     "되돌리기"
  FAIL  budget composer     chars 37 > 27
FAIL: 5 failures, 1 warnings, 22 required elements
```

## B26 (dark)

```text
  FAIL  order  rail         button   "내 계정" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "완료"
  FAIL  order  sidebar      status   "작업 중" (occurrence already consumed or found earlier)
  FAIL  order  sidebar      link     "{work_title}" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "실행 중"
  FAIL  order  sidebar      link     "{work_title}" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "확인 대기"
  FAIL  order  sidebar      link     "{member}" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "읽지 않음"
  FAIL  missing header       link     "작업 공간"
  FAIL  budget sidebar      sentences 1 > 0: "활동 보기, 확인 필요"
  FAIL  budget composer     chars 37 > 27
FAIL: 12 failures, 3 warnings, 27 required elements
```

## B26-later (dark)

```text
  FAIL  order  rail         button   "내 계정" (occurrence already consumed or found earlier)
  FAIL  role   sidebar      switch   "활동 보기" (text exists without the required role)
  FAIL  missing sidebar      status   "완료"
  FAIL  order  sidebar      status   "작업 중" (occurrence already consumed or found earlier)
  FAIL  order  sidebar      link     "{work_title}" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "실행 중"
  FAIL  order  sidebar      link     "{work_title}" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "확인 대기"
  FAIL  order  sidebar      link     "{member}" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "읽지 않음"
  FAIL  missing header       link     "작업 공간"
  FAIL  missing conversation button   "다시 묻기"
  FAIL  budget sidebar      sentences 1 > 0: "활동 보기, 확인 필요"
  FAIL  budget composer     chars 37 > 27
FAIL: 14 failures, 3 warnings, 27 required elements
```

## B1 (light)

```text
  FAIL  missing header       link     "사이드바 보기"
  FAIL  missing composer     textbox  "답변을 입력하거나 다른 이야기를 하세요"
  FAIL  budget composer     chars 37 > 27
FAIL: 3 failures, 0 warnings, 11 required elements
```

## B2 (light)

```text
  FAIL  missing sidebar      status   "실행 중"
  FAIL  order  sidebar      link     "{member}" (occurrence already consumed or found earlier)
  FAIL  missing conversation link     "사례 보기"
  FAIL  order  conversation button   "복사" (occurrence already consumed or found earlier)
  FAIL  order  conversation button   "복사" (occurrence already consumed or found earlier)
  FAIL  order  conversation text     "{date}" (occurrence already consumed or found earlier)
  FAIL  missing conversation link     "{work_title} 실행 중 퀼 {duration} 조사 분류 요약 확인 {progress} · 나누기 완료 · 원인 정리 중"
  FAIL  budget sidebar      sentences 1 > 0: "활동 보기, 확인 필요"
  FAIL  budget composer     chars 37 > 27
FAIL: 9 failures, 0 warnings, 31 required elements
```

## B2-offline (light)

```text
  FAIL  role   sidebar      switch   "활동 보기" (text exists without the required role)
  FAIL  missing sidebar      status   "실행 중"
  FAIL  order  sidebar      link     "{member}" (occurrence already consumed or found earlier)
  FAIL  budget sidebar      sentences 1 > 0: "활동 보기, 확인 필요"
FAIL: 4 failures, 2 warnings, 20 required elements
```

## B2-offline-failed (light)

```text
  FAIL  role   sidebar      switch   "활동 보기" (text exists without the required role)
  FAIL  missing sidebar      status   "실행 중"
  FAIL  order  sidebar      link     "{member}" (occurrence already consumed or found earlier)
  FAIL  missing composer     status   "보내지 못함 · 다시 보내기"
  FAIL  budget sidebar      sentences 1 > 0: "활동 보기, 확인 필요"
FAIL: 5 failures, 2 warnings, 22 required elements
```

## B3 (light)

```text
  FAIL  missing sidebar      status   "실행 중"
  FAIL  order  sidebar      link     "{member}" (occurrence already consumed or found earlier)
  FAIL  missing conversation link     "반올림 규칙"
  FAIL  budget composer     chars 37 > 27
FAIL: 4 failures, 1 warnings, 22 required elements
```

## B3-run (light)

```text
  FAIL  missing sidebar      status   "실행 중"
  FAIL  order  sidebar      link     "{member}" (occurrence already consumed or found earlier)
  FAIL  missing conversation link     "반올림 규칙"
  FAIL  missing conversation link     "{work_title} 실행 중 퀼 {duration} 조사 분류 요약 확인 {progress} · 나누기 완료 · 원인 정리 중"
  FAIL  budget composer     chars 37 > 27
FAIL: 5 failures, 1 warnings, 23 required elements
```

## B4 (light)

```text
  FAIL  order  rail         button   "내 계정" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "결정 대기"
  FAIL  order  sidebar      status   "작업 중" (occurrence already consumed or found earlier)
  FAIL  order  sidebar      link     "{work_title}" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "실행 중"
  FAIL  order  sidebar      link     "{work_title}" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "확인 대기"
  FAIL  order  sidebar      link     "{member}" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "읽지 않음"
  FAIL  missing conversation button   "{duration} 동안 작업 · 페이지 {count} 읽음"
  FAIL  missing pane         link     "작업 공간 닫기"
  FAIL  region pane         text     "{amount}" (found in conversation)
  FAIL  region pane         text     "{amount}" (found in conversation)
  FAIL  region pane         text     "{amount}" (found in conversation)
  FAIL  budget sidebar      sentences 1 > 0: "활동 보기, 확인 필요"
  FAIL  budget composer     chars 37 > 27
  FAIL  budget pane         sentences 2 > 0: "기존 차단 유지 · 취소해도 외부 실행은 되돌려지지 않습니다"
  FAIL  budget pane         longest string 33 > 24 chars
  FAIL  budget pane         chars 730 > 203
FAIL: 19 failures, 0 warnings, 35 required elements
```

## B5 (light)

```text
  FAIL  order  rail         button   "내 계정" (occurrence already consumed or found earlier)
  FAIL  missing header       link     "사이드바 보기"
  FAIL  missing header       link     "작업 공간"
  FAIL  missing conversation button   "{duration} 동안 작업 · 페이지 {count} 읽음"
  FAIL  missing conversation button   "주문 내역 확인"
  FAIL  missing conversation button   "닫기"
  FAIL  budget composer     chars 37 > 27
FAIL: 7 failures, 0 warnings, 17 required elements
```

## B6 (light)

```text
  FAIL  order  rail         button   "내 계정" (occurrence already consumed or found earlier)
  FAIL  role   sidebar      switch   "활동 보기" (text exists without the required role)
  FAIL  missing sidebar      status   "작업 중"
  FAIL  region sidebar      status   "실패" (found in conversation)
  FAIL  order  sidebar      link     "{work_title}" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "확인 대기"
  FAIL  order  sidebar      link     "{member}" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "읽지 않음"
  FAIL  missing header       link     "작업 공간"
  FAIL  missing conversation link     "{work_title} 실패 {time} – {time} 조사 분류 요약 확인 확인 실패 · 근거 {count}"
  FAIL  missing conversation link     "방향 바꿈: {work_title} · {time}"
  FAIL  order  conversation button   "복사" (occurrence already consumed or found earlier)
  FAIL  missing conversation link     "{work_title} 확인 대기 {duration} 조사 표 정리 확인 표 {count} · 확인 대기"
  FAIL  missing conversation button   "남기기"
  FAIL  missing conversation button   "지우기"
  FAIL  order  conversation button   "복사" (occurrence already consumed or found earlier)
  FAIL  missing composer     textbox  "퀼에게 메시지 보내기"
  FAIL  budget sidebar      sentences 1 > 0: "활동 보기, 확인 필요"
  FAIL  budget composer     chars 37 > 27
FAIL: 19 failures, 1 warnings, 34 required elements
```

## B6-token (light)

```text
  FAIL  order  rail         button   "내 계정" (occurrence already consumed or found earlier)
  FAIL  role   sidebar      switch   "활동 보기" (text exists without the required role)
  FAIL  missing sidebar      status   "작업 중"
  FAIL  missing sidebar      status   "실행 중"
  FAIL  order  sidebar      link     "{work_title}" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "실행 중"
  FAIL  order  sidebar      link     "{member}" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "작업 중"
  FAIL  order  sidebar      link     "{work_title}" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "실행 중"
  FAIL  missing header       link     "작업 공간"
  FAIL  budget sidebar      sentences 1 > 0: "활동 보기, 확인 필요"
  FAIL  budget composer     chars 37 > 27
FAIL: 13 failures, 3 warnings, 28 required elements
```

## B11 (light)

```text
  FAIL  role   sidebar      switch   "활동 보기" (text exists without the required role)
  FAIL  order  page         option   "Enter" (occurrence already consumed or found earlier)
  FAIL  order  page         option   "{member}" (occurrence already consumed or found earlier)
  FAIL  order  page         link     "구성원 관리" (occurrence already consumed or found earlier)
  FAIL  order  page         button   "복사" (occurrence already consumed or found earlier)
  FAIL  budget sidebar      sentences 1 > 0: "활동 보기, 확인 필요"
  FAIL  budget sidebar      chars 31 > 25
FAIL: 7 failures, 2 warnings, 22 required elements
```

## B11-quill (light)

```text
  FAIL  role   sidebar      switch   "활동 보기" (text exists without the required role)
  FAIL  budget sidebar      sentences 1 > 0: "활동 보기, 확인 필요"
  FAIL  budget sidebar      chars 31 > 25
  FAIL  budget composer     chars 37 > 27
FAIL: 4 failures, 2 warnings, 17 required elements
```

## B16 (light)

```text
  FAIL  missing sidebar      button   "우선순위"
  FAIL  missing sidebar      link     "깨지는 테스트 고치기 노트북의 Claude Code에게 처음 맡길까요?"
  FAIL  missing sidebar      link     "반올림 규칙 바꾸기 합계에서 한 번 반올림으로 바꿀까요? 지금 규칙 {progress}, 새 규칙 {progress}."
  FAIL  missing sidebar      status   "읽지 않음"
  FAIL  budget composer     chars 37 > 27
FAIL: 5 failures, 0 warnings, 22 required elements
```

## B16-later (light)

```text
  FAIL  missing sidebar      button   "우선순위"
  FAIL  missing sidebar      link     "반올림 규칙 바꾸기 합계에서 한 번 반올림으로 바꿀까요? 지금 규칙 {progress}, 새 규칙 {progress}."
  FAIL  missing sidebar      status   "읽지 않음"
  FAIL  order  conversation button   "복사" (occurrence already consumed or found earlier)
  FAIL  budget composer     chars 37 > 27
FAIL: 5 failures, 0 warnings, 21 required elements
```

## B16-sent (light)

```text
  FAIL  missing sidebar      button   "우선순위"
  FAIL  missing sidebar      link     "반올림 규칙 바꾸기 합계에서 한 번 반올림으로 바꿀까요? 지금 규칙 {progress}, 새 규칙 {progress}."
  FAIL  missing sidebar      status   "읽지 않음"
  FAIL  missing sidebar      link     "깨지는 테스트 고치기 09:13에 보냈어요. 응답 대기예요."
  FAIL  order  conversation button   "복사" (occurrence already consumed or found earlier)
  FAIL  budget composer     chars 37 > 27
FAIL: 6 failures, 1 warnings, 21 required elements
```

## B18 (light)

```text
  FAIL  order  rail         button   "내 계정" (occurrence already consumed or found earlier)
  FAIL  role   sidebar      switch   "활동 보기" (text exists without the required role)
  FAIL  missing sidebar      status   "실행 중"
  FAIL  order  sidebar      link     "{work_title}" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "확인 대기"
  FAIL  order  sidebar      link     "{member}" (occurrence already consumed or found earlier)
  FAIL  order  sidebar      status   "작업 중" (occurrence already consumed or found earlier)
  FAIL  order  sidebar      link     "{work_title}" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "실행 중"
  FAIL  missing header       link     "작업 공간"
  FAIL  missing conversation link     "{work_title} 실행 중 {duration} 조사 분류 요약 확인 나누기 완료 · 원인 정리 중"
  FAIL  missing conversation link     "방향 바꿈: {work_title} · {time}"
  FAIL  missing conversation link     "{work_title} 확인 대기 {duration} 조사 표 정리 확인 표 {count} · 확인 대기"
  FAIL  missing conversation button   "남기기"
  FAIL  missing conversation button   "지우기"
  FAIL  budget sidebar      sentences 1 > 0: "활동 보기, 확인 필요"
  FAIL  budget composer     chars 36 > 27
FAIL: 17 failures, 2 warnings, 34 required elements
```

## B21 (light)

```text
  FAIL  missing sidebar      status   "작업 중"
  FAIL  missing sidebar      status   "실행 중"
  FAIL  order  sidebar      link     "{member}" (occurrence already consumed or found earlier)
  FAIL  budget sidebar      sentences 1 > 0: "활동 보기, 확인 필요"
  FAIL  budget composer     chars 37 > 27
FAIL: 5 failures, 1 warnings, 21 required elements
```

## B21-name (light)

```text
  FAIL  missing sidebar      status   "작업 중"
  FAIL  missing sidebar      status   "실행 중"
  FAIL  order  sidebar      link     "{member}" (occurrence already consumed or found earlier)
  FAIL  role   dialog:새 구성원 만들기 button   "동그라미" (text exists without the required role)
  FAIL  role   dialog:새 구성원 만들기 button   "네모" (text exists without the required role)
  FAIL  role   dialog:새 구성원 만들기 button   "물방울" (text exists without the required role)
  FAIL  role   dialog:새 구성원 만들기 button   "육각" (text exists without the required role)
  FAIL  role   dialog:새 구성원 만들기 button   "마름모" (text exists without the required role)
  FAIL  role   dialog:새 구성원 만들기 button   "구름" (text exists without the required role)
  FAIL  role   dialog:새 구성원 만들기 button   "세 잎" (text exists without the required role)
  FAIL  role   dialog:새 구성원 만들기 button   "세모" (text exists without the required role)
  FAIL  budget sidebar      sentences 1 > 0: "활동 보기, 확인 필요"
  FAIL  budget composer     chars 37 > 27
FAIL: 13 failures, 2 warnings, 33 required elements
```

## B21-done (light)

```text
  FAIL  missing sidebar      status   "작업 중"
  FAIL  missing sidebar      status   "실행 중"
  FAIL  order  sidebar      link     "{member}" (occurrence already consumed or found earlier)
  FAIL  budget composer     chars 36 > 27
FAIL: 4 failures, 1 warnings, 20 required elements
```

## B21-done-hana (light)

```text
  FAIL  missing sidebar      status   "작업 중"
  FAIL  missing sidebar      status   "실행 중"
  FAIL  order  sidebar      link     "{member}" (occurrence already consumed or found earlier)
  FAIL  missing conversation link     "되돌리기"
  FAIL  budget composer     chars 37 > 27
FAIL: 5 failures, 1 warnings, 22 required elements
```

## B26 (light)

```text
  FAIL  order  rail         button   "내 계정" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "완료"
  FAIL  order  sidebar      status   "작업 중" (occurrence already consumed or found earlier)
  FAIL  order  sidebar      link     "{work_title}" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "실행 중"
  FAIL  order  sidebar      link     "{work_title}" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "확인 대기"
  FAIL  order  sidebar      link     "{member}" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "읽지 않음"
  FAIL  missing header       link     "작업 공간"
  FAIL  budget sidebar      sentences 1 > 0: "활동 보기, 확인 필요"
  FAIL  budget composer     chars 37 > 27
FAIL: 12 failures, 3 warnings, 27 required elements
```

## B26-later (light)

```text
  FAIL  order  rail         button   "내 계정" (occurrence already consumed or found earlier)
  FAIL  role   sidebar      switch   "활동 보기" (text exists without the required role)
  FAIL  missing sidebar      status   "완료"
  FAIL  order  sidebar      status   "작업 중" (occurrence already consumed or found earlier)
  FAIL  order  sidebar      link     "{work_title}" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "실행 중"
  FAIL  order  sidebar      link     "{work_title}" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "확인 대기"
  FAIL  order  sidebar      link     "{member}" (occurrence already consumed or found earlier)
  FAIL  missing sidebar      status   "읽지 않음"
  FAIL  missing header       link     "작업 공간"
  FAIL  missing conversation button   "다시 묻기"
  FAIL  budget sidebar      sentences 1 > 0: "활동 보기, 확인 필요"
  FAIL  budget composer     chars 37 > 27
FAIL: 14 failures, 3 warnings, 27 required elements
```
