export function slotPickerVisibleLabel(
  filename: string | null | undefined,
  extraDocs = 0,
): string {
  const name = filename?.trim() ?? '';
  if (!name) return '';
  return `${name}${extraDocs > 0 ? ` (+${extraDocs})` : ''}`;
}

export function slotPickerAriaLabel(panelNumber: string, visibleLabel: string): string {
  return visibleLabel ? `Panel ${panelNumber}: ${visibleLabel}` : `Panel ${panelNumber}`;
}

export const slotPickerVisibleLabelForTests = slotPickerVisibleLabel;
export const slotPickerAriaLabelForTests = slotPickerAriaLabel;
