import supabase from "./client.js";

// The site's account marked primary in the accounts table
// (supabase/shared/accounts.sql) — what the engine logs in with there — or
// null when none is, and the run goes ahead as a guest. Switching accounts
// is a database edit; there is no .env fallback.
export async function getPrimaryAccount(site) {
  const { data, error } = await supabase
    .from("accounts")
    .select("email, password")
    .eq("site", site)
    .eq("is_primary", true)
    .maybeSingle();

  if (error) throw new Error(`Failed to fetch the primary account: ${error.message}`);
  return data;
}
