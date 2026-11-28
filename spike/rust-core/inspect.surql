RETURN {
  states: (SELECT * FROM massion_state ORDER BY id),
  audit: (SELECT * FROM massion_audit ORDER BY id),
  events: (SELECT * FROM massion_event ORDER BY id),
  outbox: (SELECT * FROM massion_outbox ORDER BY id)
};
