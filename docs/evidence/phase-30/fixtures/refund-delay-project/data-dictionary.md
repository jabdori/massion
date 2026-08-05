# Data dictionary

- `refund_id`: anonymous refund identifier.
- `requested_at`: customer request time.
- `reviewed_at`: manual review completion time.
- `batched_at`: payment batch admission time.
- `paid_at`: confirmed payment time.
- All timestamps are ISO 8601 and use Korea Standard Time (`+09:00`).
- This dataset contains no missing timestamps. Durations are calculated between adjacent stages.
