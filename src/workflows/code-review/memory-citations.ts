/** Extract explicit learning identifiers from the model's structured output. */
export function citedLearningIds(output: string): Set<number> {
  const ids = new Set<number>();
  for (const match of output.matchAll(/\blearning\s+#([1-9][0-9]*)(?![A-Za-z0-9_])/gi)) {
    const id = Number(match[1]);
    if (Number.isSafeInteger(id)) ids.add(id);
  }
  return ids;
}
