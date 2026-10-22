import coomeet from "./coomeet/index.js";

// Every site the engine archives. A site is a folder here, with its own
// tables in supabase/<id>/, and exports:
//
//   id       its name, as the --site option, the runs log and the accounts
//            table know it ("coomeet"), and the prefix of its tables
//   method   how it reads the site, for the runs log ("feed")
//   archive({ page, account, limit, report })
//            reads the site in `page` (a browser tab, already set up by
//            src/core/browser.js), logged in with `account` ({ email,
//            password }) when there is one, and saves what's new; fills in
//            `report` — guest, storiesFound, saved, … (see src/db/runs.js)
//            — as it goes, even when it fails partway
//   faces    { todo(limit), record(scans) }: its images still to look for
//            faces in, and where their faces go (src/faces/indexer.js)
//
// The rest — the browser, the run's log, the faces, the schedule — is
// shared (src/core/, src/db/, src/faces/).
export const SITES = { coomeet };
