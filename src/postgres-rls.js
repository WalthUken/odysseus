"use strict";

const POSTGRES_RLS_REQUIREMENTS = Object.freeze({
  required: true,
  accountScopedTables: Object.freeze([
    "audit_events",
    "behavior_profiles",
    "device_profile_links",
    "devices",
    "profile_transfers",
    "recovery_codes",
    "recovery_requests",
    "security_notifications",
    "sessions",
    "webauthn_challenges",
    "webauthn_credentials",
  ]),
  requirements: Object.freeze([
    "Enable and force row level security on every account-scoped table.",
    "Bind account access to a trusted server-set user identifier.",
    "Create separate least-privilege policies for select, insert, update, and delete.",
    "Keep administrator aggregate access in security-definer functions that return no row-level identifiers.",
    "Test cross-account denial for every policy before deployment.",
    "Never use an application role that bypasses row level security.",
  ]),
});

module.exports = {
  POSTGRES_RLS_REQUIREMENTS,
};
