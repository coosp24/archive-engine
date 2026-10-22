import { getPrimaryAccount } from "../db/accounts.js";
import { launchBrowser, preparePage } from "./browser.js";
import { formatDuration, line } from "./log.js";

// One run of a site (see src/sites/index.js): the site's account, a browser
// when the site reads its pages (site.browser), and the site's archive() —
// then the browser closed whatever happened. Answers the run's report for
// the runs log; a failure is in it as `error` (and sets the exit code), not
// thrown, so the report is always saved.
export async function runSite(site, { browser: browserOptions, guest, limit }) {
  const startedAt = Date.now();
  const report = { site: site.id, method: site.method, startedAt, limit };
  let browser;
  let megabytes = null;
  try {
    // With no primary account for the site, the run goes ahead as a guest.
    const account = guest ? null : await getPrimaryAccount(site.id);
    if (!account) {
      console.log(
        guest ? "👤 Running as a guest — not logged in" : `👤 No primary ${site.id} account — running as a guest`,
      );
    }
    let page = null;
    if (site.browser) {
      browser = await launchBrowser(browserOptions);
      page = await browser.newPage();
      megabytes = await preparePage(page, browserOptions);
    }
    await site.archive({ page, account, limit, report });
  } catch (error) {
    console.error(`❌ ${error.message}`);
    report.error = error.message;
    process.exitCode = 1;
  } finally {
    await browser?.close();
    report.finishedAt = Date.now();
    // A site without a browser counts its own traffic into the report.
    if (megabytes) report.dataMB = megabytes();
    if (report.dataMB != null) report.dataMB = Math.round(report.dataMB * 100) / 100;
    line();
    console.log(`📡 Data consumed:   ${report.dataMB ?? 0} MB`);
    console.log(`⏱️  Total time:      ${formatDuration(report.finishedAt - startedAt)}`);
  }
  return report;
}
