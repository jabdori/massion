
BEGIN TRANSACTION;
RETURN {
DEFINE TABLE IF NOT EXISTS massion_state SCHEMALESS;
DEFINE TABLE IF NOT EXISTS massion_operation SCHEMALESS;
DEFINE TABLE IF NOT EXISTS massion_audit SCHEMALESS;
DEFINE TABLE IF NOT EXISTS massion_event SCHEMALESS;
DEFINE TABLE IF NOT EXISTS massion_outbox SCHEMALESS;
DEFINE TABLE IF NOT EXISTS massion_feed SCHEMALESS;
DEFINE TABLE IF NOT EXISTS massion_host_settings SCHEMALESS;
LET $feed = SELECT * FROM ONLY massion_feed:global;
IF $feed = NONE {
  IF array::len(SELECT id FROM massion_operation LIMIT 1) > 0 OR
    array::len(SELECT id FROM massion_state LIMIT 1) > 0 OR
    array::len(SELECT id FROM massion_audit LIMIT 1) > 0 OR
    array::len(SELECT id FROM massion_event LIMIT 1) > 0 OR
    array::len(SELECT id FROM massion_outbox LIMIT 1) > 0 {
    THROW 'Existing operation journal requires an explicit event-cursor migration';
  };
  CREATE massion_feed:global CONTENT { cursor: 0, schemaVersion: 2 };
} ELSE IF $feed.schemaVersion != 2 {
  THROW 'Unsupported storage schema version';
};
DEFINE FIELD IF NOT EXISTS cursor ON massion_feed TYPE int ASSERT $value >= 0 AND $value <= 9007199254740991;
DEFINE FIELD IF NOT EXISTS cursor ON massion_operation TYPE int ASSERT $value > 0 AND $value <= 9007199254740991;
DEFINE INDEX IF NOT EXISTS operation_cursor ON massion_operation FIELDS cursor UNIQUE;
IF $feed.feedId = NONE { UPDATE massion_feed:global SET feedId = $feedId; };
RETURN true;
};
COMMIT TRANSACTION;
