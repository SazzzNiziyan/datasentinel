/**
 * SAMPLE DATA. Stands in for the signed-in session until workspace access
 * is built (roadmap Phase E). The shell labels it as sample wherever shown.
 */
export const sampleSession = {
  isSample: true,
  workspace: { name: 'Northwind Retail' },
  user: { name: 'Ana Kovac', email: 'ana@northwind.example', initials: 'AK' },
  role: 'Data engineer',
} as const;
