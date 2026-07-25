BEGIN;

DO $odysseus_rls$
DECLARE
  table_name text;
  policy_name text;
  existing_policy record;
  account_tables text[] := ARRAY[
    'audit_events',
    'behavior_profiles',
    'device_profile_links',
    'devices',
    'profile_transfers',
    'recovery_codes',
    'recovery_requests',
    'security_notifications',
    'sessions',
    'webauthn_challenges',
    'webauthn_credentials'
  ];
BEGIN
  FOREACH table_name IN ARRAY account_tables
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',
      table_name
    );
    EXECUTE format(
      'ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',
      table_name
    );

    FOR existing_policy IN
      SELECT policyname
      FROM pg_catalog.pg_policies
      WHERE schemaname = 'public'
        AND tablename = table_name
    LOOP
      EXECUTE format(
        'DROP POLICY %I ON public.%I',
        existing_policy.policyname,
        table_name
      );
    END LOOP;

    policy_name := table_name || '_account_select';
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT USING (
        user_id = nullif(current_setting(''odysseus.user_id'', true), '''')::bigint
      )',
      policy_name,
      table_name
    );

    policy_name := table_name || '_account_insert';
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (
        user_id = nullif(current_setting(''odysseus.user_id'', true), '''')::bigint
      )',
      policy_name,
      table_name
    );

    policy_name := table_name || '_account_update';
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE USING (
        user_id = nullif(current_setting(''odysseus.user_id'', true), '''')::bigint
      ) WITH CHECK (
        user_id = nullif(current_setting(''odysseus.user_id'', true), '''')::bigint
      )',
      policy_name,
      table_name
    );

    policy_name := table_name || '_account_delete';
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE USING (
        user_id = nullif(current_setting(''odysseus.user_id'', true), '''')::bigint
      )',
      policy_name,
      table_name
    );
  END LOOP;
END
$odysseus_rls$;

COMMIT;
