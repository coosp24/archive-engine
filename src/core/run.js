import { getPrimaryAccount } from "../db/accounts.js";
import { launchBrowser, preparePage } from "./browser.js";
import { formatDuration, line } from "./log.js";

// One run of a site (see src/sites/index.js): a browser, the site's account,
// and the site's archive() — then the browser closed whatever happened.
// Answers the run's report for the runs log; a failure is in it as `error`
// (and sets the exit code), not thrown, so the report is always saved.
export async function runSite(site, { browser: browserOptions, guest, limit }) {
  const startedAt = Date.now();
  const report = { site: site.id, method: site.method, startedAt, limit };
  let browser;
  let megabytes = () => 0;
  try {
    // With no primary account for the site, the run goes ahead as a guest.
    const account = guest ? null : await getPrimaryAccount(site.id);
    if (!account) {
      console.log(
        guest ? "👤 Running as a guest — not logged in" : `👤 No primary ${site.id} account — running as a guest`,
      );
    }
    browser = await launchBrowser(browserOptions);
    const page = await browser.newPage();
    megabytes = await preparePage(page, browserOptions);
    await site.archive({ page, account, limit, report });
  } catch (error) {
    console.error(`❌ ${error.message}`);
    report.error = error.message;
    process.exitCode = 1;
  } finally {
    await browser?.close();
    report.finishedAt = Date.now();
    report.dataMB = Math.round(megabytes() * 100) / 100;
    line();
    console.log(`📡 Data consumed:   ${report.dataMB} MB`);
    console.log(`⏱️  Total time:      ${formatDuration(report.finishedAt - startedAt)}`);
  }
  return report;
}
