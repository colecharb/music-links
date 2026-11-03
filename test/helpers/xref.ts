// In-memory Spotify cross-reference (src/xref.ts XrefStore) for resolve tests.
import type { ItemMeta, Kind } from '../../src/types';
import { XREF_MAX_PER_IDENTIFIER, type WaitingRow, type XrefHit, type XrefStore } from '../../src/xref';

export class MemoryXref implements XrefStore {
  /** `${kind}:${identifier}` -> Spotify items, most recently learned first. */
  readonly mappings = new Map<string, ItemMeta[]>();
  readonly waiting: Array<WaitingRow & { kind: Kind }> = [];
  /** Identifiers of every lookup, in call order. */
  readonly lookups: string[][] = [];
  /** Called at each lookup; may throw or return a promise that never settles. */
  onLookup?: (kind: Kind, identifiers: string[]) => void | Promise<void>;

  /** Map the identifier to this item too (most recent first, as d1Xref keeps them). */
  set(kind: Kind, identifier: string, item: ItemMeta): this {
    const k = `${kind}:${identifier}`;
    const items = (this.mappings.get(k) ?? []).filter((i) => i.id !== item.id);
    this.mappings.set(k, [item, ...items].slice(0, XREF_MAX_PER_IDENTIFIER));
    return this;
  }

  private hits(kind: Kind, identifiers: string[]): XrefHit[] {
    return identifiers.flatMap((identifier) => (this.mappings.get(`${kind}:${identifier}`) ?? []).map((item) => ({ identifier, item })));
  }

  async lookup(kind: Kind, identifiers: string[]): Promise<XrefHit[]> {
    this.lookups.push(identifiers);
    await this.onLookup?.(kind, identifiers);
    return this.hits(kind, identifiers);
  }

  async learn(item: ItemMeta, identifiers: string[]): Promise<{ waiting: WaitingRow[]; hits: XrefHit[] }> {
    for (const id of identifiers) this.set(item.kind, id, item);
    return {
      waiting: this.waiting
        .filter((w) => w.kind === item.kind && identifiers.includes(w.identifier))
        .map(({ identifier, cacheKey, resolvedAt }) => ({ identifier, cacheKey, resolvedAt })),
      hits: this.hits(item.kind, identifiers),
    };
  }

  async wait(kind: Kind, identifiers: string[], cacheKey: string, resolvedAt: string): Promise<XrefHit[]> {
    for (const identifier of identifiers) {
      const row = this.waiting.find((w) => w.kind === kind && w.identifier === identifier && w.cacheKey === cacheKey);
      if (row) row.resolvedAt = resolvedAt;
      else this.waiting.push({ kind, identifier, cacheKey, resolvedAt });
    }
    return this.hits(kind, identifiers);
  }

  async unwait(cacheKeys: string[]): Promise<void> {
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      if (cacheKeys.includes(this.waiting[i]!.cacheKey)) this.waiting.splice(i, 1);
    }
  }
}
