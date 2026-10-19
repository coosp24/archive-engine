import supabase from "../util/supabase.js";

// The account marked primary in the accounts table (supabase/accounts.sql) —
// what the engine logs in with — or null when none is, and the run goes
// ahead as a guest. Switching accounts is a database edit; there is no .env
// fallback.
export const getPrimaryAccount = async () => {
  const { data, error } = await supabase
    .from("accounts")
    .select("email, password")
    .eq("is_primary", true)
    .maybeSingle();

  if (error) {
    throw new Error(`❌ Failed to fetch the primary account: ${error.message}`);
  }
  return data;
};
