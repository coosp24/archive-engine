// The engine's entry point: `node .` (see src/cli.js for its options).
// Loaded inside the try, so a problem found while loading (no Supabase key
// set, say) is reported like any other, not as a stack trace.
try {
  const { main } = await import("./src/cli.js");
  await main();
} catch (error) {
  console.error(`❌ ${error.message}`);
  process.exitCode = 1;
}
