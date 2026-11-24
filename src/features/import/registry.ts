import type { ImportParser, SourceId } from './types';
import { dhan } from './parsers/dhan';
import { angelone, groww, upstox, zerodha } from './parsers/fills';
import { genericCsv } from './parsers/generic';
import { mt4, mt5 } from './parsers/mt';
import { zerodhaPnl } from './parsers/zerodhaPnl';

export const PARSERS: ImportParser[] = [zerodha, zerodhaPnl, dhan, upstox, angelone, groww, mt4, mt5, genericCsv];

export const parserById = (id: string): ImportParser | undefined => PARSERS.find((p) => p.id === id);

export const SOURCE_IDS = PARSERS.map((p) => p.id) as SourceId[];

export function sourcesMetadata() {
  return PARSERS.map((p) => ({
    id: p.id,
    name: p.name,
    assetClasses: p.assetClasses,
    fileTypes: p.fileTypes,
    howToExport: p.howToExport,
    sampleColumns: p.sampleColumns,
  }));
}
