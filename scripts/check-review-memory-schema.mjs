// Consume the JSON result of a read-only D1 schema query on stdin.
let input = '';
for await (const chunk of process.stdin) input += chunk;

try {
  const data = JSON.parse(input);
  const row = Array.isArray(data) ? data[0]?.results?.[0] : null;
  if (row?.migration_applied !== 1 || row?.links_table !== 1 ||
      row?.reaction_migration_applied !== 1 || row?.reaction_targets_table !== 1 ||
      row?.reaction_created_at_column !== 1 || row?.reaction_trigger !== 1) {
    throw new Error('missing migration or links table');
  }
  console.log('Review memory schema is ready.');
} catch {
  console.error('Review memory schema is not ready; apply D1 migrations 0009 and 0010 before deploying.');
  process.exitCode = 1;
}
