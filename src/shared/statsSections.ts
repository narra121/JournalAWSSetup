/**
 * The `sections` value as the get-stats handler receives it: the Web Function adapter joins a repeated query key with
 * commas (src/app/http/adapter.ts), so the Pro gate and the handler must both split that joined string.
 */
export function wantsAdvancedSection(sections: string | undefined): boolean {
  return (sections || '').split(',').includes('advanced');
}
