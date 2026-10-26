-- Run against your existing database.

-- audit_log.action only allowed 'created', 'updated' and 'deleted', but
-- the backend also logs 'copied' (copying restrictions to another group,
-- groupRoutes.js) and 'bulk_upload' (schedule bulk upload,
-- scheduleRoutes.js). Those inserts failed with "Data truncated for
-- column 'action'" and the entries were lost - logAction never throws,
-- so the actions themselves still succeeded. Adding values to the ENUM
-- leaves existing rows untouched.
--
-- Any new action passed to logAction (services/auditLog.js) needs to be
-- added here first.
ALTER TABLE audit_log
  MODIFY action ENUM('created','updated','deleted','copied','bulk_upload') NOT NULL;
