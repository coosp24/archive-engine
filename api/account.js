import supabase from "../util/supabase.js";

// The account marked primary in the accounts table (supabase/accounts.sql) —
// what the engine logs in with. Switching accounts is a database edit; there
// is no .env fallback.
export const getPrimaryAccount = async () => {
  const { data, error } = await supabase
    .from("accounts")
    .select("email, password")
    .eq("is_primary", true)
    .maybeSingle();

  if (error) {
    throw new Error(`❌ Failed to fetch the primary account: ${error.message}`);
  }
  if (!data) {
    throw new Error(
      "❌ No primary account. Add one to the accounts table with is_primary = true (see supabase/accounts.sql), or run with --guest",
    );
  }
  return data;
};
