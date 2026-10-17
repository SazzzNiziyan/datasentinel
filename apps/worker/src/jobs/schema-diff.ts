/** A column as stored in a schema snapshot (D-43). */
export type SchemaColumn = { name: string; type: string; nullable: boolean };

export type SchemaDiff = {
  changed: boolean;
  /** In the newer snapshot's order. */
  added: { name: string; type: string }[];
  /** In the older snapshot's order. */
  removed: { name: string; type: string }[];
  typeChanged: { name: string; from: string; to: string }[];
};

/** Compares two schema snapshots by exact column name (D-57). Column order
 * and nullability are not changes; a renamed column shows as one removed
 * and one added, since a rename cannot be told apart from a swap. */
export function diffSchemas(
  before: readonly SchemaColumn[],
  after: readonly SchemaColumn[],
): SchemaDiff {
  const old = new Map(before.map((c) => [c.name, c]));
  const next = new Map(after.map((c) => [c.name, c]));
  const added = after.filter((c) => !old.has(c.name)).map(({ name, type }) => ({ name, type }));
  const removed = before.filter((c) => !next.has(c.name)).map(({ name, type }) => ({ name, type }));
  const typeChanged = after.flatMap((c) => {
    const was = old.get(c.name);
    return was !== undefined && was.type !== c.type
      ? [{ name: c.name, from: was.type, to: c.type }]
      : [];
  });
  return {
    changed: added.length + removed.length + typeChanged.length > 0,
    added,
    removed,
    typeChanged,
  };
}

/** Columns of a stored snapshot, or null when the JSON is not a column list,
 * so a damaged snapshot is never compared as an empty schema. */
export function readSchemaColumns(columns: unknown): SchemaColumn[] | null {
  if (!Array.isArray(columns)) return null;
  const result: SchemaColumn[] = [];
  for (const c of columns as unknown[]) {
    if (typeof c !== 'object' || c === null) return null;
    const { name, type, nullable } = c as Record<string, unknown>;
    if (typeof name !== 'string' || typeof type !== 'string' || typeof nullable !== 'boolean') {
      return null;
    }
    result.push({ name, type, nullable });
  }
  return result;
}
