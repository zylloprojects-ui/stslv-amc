-- 0073_notification_reads
-- Per-user read state of the in-app alerts. The alerts themselves are not
-- stored: they are worked out on request from the current records (overdue
-- visits, contracts past validity, work waiting for an invoice). A read mark
-- holds the alert's state when it was read ("fingerprint"); the alert shows as
-- unread again when that state changes. Marking an alert read changes nothing
-- else.
--
-- To reverse (with approval): DROP TABLE notification_reads;

CREATE TABLE notification_reads (
  user_id     bigint      NOT NULL,
  alert_key   text        NOT NULL,
  fingerprint text        NOT NULL,
  read_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_reads_pk PRIMARY KEY (user_id, alert_key),
  CONSTRAINT notification_reads_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT notification_reads_alert_key_ck CHECK (alert_key ~ '^[a-z_.]{1,60}$')
);
