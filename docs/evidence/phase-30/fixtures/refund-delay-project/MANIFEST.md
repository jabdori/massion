# Refund delay UAT input manifest

이 디렉터리는 실제 파일 기반 Massion Work를 재현하기 위한 synthetic input 정본입니다. 고객·production data가 없습니다.

## 파일 SHA-256

```text
c787cd0c0ebb66f9e098adc08a479c03a851407e1754b93ee0fa9159b6e59783  README.md
287a3aac95d12f2c2ae59983888871c2c00e206836d1fc79d2fe5400974fda64  batch-policy.md
81525f0ea2786af4c408140dc9d83e98248c7a748805bec9a2230ab66cf3bf61  data-dictionary.md
60eae12a4dfa469d9b04228e1b33123c9508fe97d148b01b4ea1f4dd50cfc5d4  refunds.csv
```

## 기대 계산

- 요청 → 검토 평균: 2.7917시간
- 검토 → batch 평균: 20.5417시간
- batch → 지급 평균: 2.0000시간

## 자연어 요청

```text
이 폴더의 환불 처리 기록을 분석해 가장 큰 지연 구간과 개선안을 찾고, 근거가 되는 수치와 되돌리기 조건을 refund-delay-report.md에 정리해 주세요.
```

`UAT`, 내부 실행 단계, Agent·모델·동적 배치 지시를 요청에 추가하지 않습니다.
