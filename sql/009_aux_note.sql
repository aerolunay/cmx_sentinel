-- Run against your existing database.

-- Free-text note on an aux segment, e.g. 'Auto set to Idle due to
-- inactivity' on the Idle row the desktop (2.3.4+) opens when an agent
-- in Production had no activity for 5 minutes and didn't answer the
-- 1-minute prompt - that Idle row starts at their last activity, and
-- the Production row before it ends there. Adds an empty column only;
-- existing rows are untouched.
ALTER TABLE aux_events
    ADD COLUMN aux_note VARCHAR(255) NULL AFTER aux_code;
