# Refund batch policy

- Reviewed refunds enter the next daily payment batch at 09:00 KST.
- The previous recoverable configuration ran batches at 09:00 and 17:00 KST.
- Reverting to the current once-daily 09:00 schedule requires no data migration.
- Operations can revert by restoring `batch_schedule=09:00` and draining the active queue before restart.
