/** Reconcile the content store against the canonical navigation allowlist. */
export function summaryDocsLoader(loader, pages) {
  const allowed = new Set(pages.map((page) => page.route || 'index'));
  return {
    name: 'govstack-summary-docs',
    async load(context) {
      await loader.load(context);
      for (const id of context.store.keys()) {
        if (!allowed.has(id)) context.store.delete(id);
      }
    },
  };
}
