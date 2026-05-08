/**
 * Helpers de formatage pour l'affichage.
 */

const FR_LOCALE = 'fr-FR';

export function formatDate(date: Date = new Date()): string {
  return date.toLocaleDateString(FR_LOCALE, {
    weekday: 'long',
    day: 'numeric',
    month: 'long'
  }).toUpperCase();
}

export function formatCurrency(value: number): string {
  return value.toLocaleString(FR_LOCALE, {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

export function formatPower(watts: number): string {
  if (Math.abs(watts) >= 1000) {
    return `${(watts / 1000).toFixed(2)} kW`;
  }
  return `${Math.round(watts)} W`;
}

export function formatTemp(celsius: number, decimals = 0): string {
  return `${celsius.toFixed(decimals)}°C`;
}
