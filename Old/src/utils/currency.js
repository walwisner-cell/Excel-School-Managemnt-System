// Converts an amount in `currency` to its USD equivalent, using the given LRD-per-USD
// rate (only meaningful when currency is 'LRD' - USD amounts pass through unchanged).
function toUSD(amount, currency, rateLrdPerUsd) {
  if (currency === 'USD') return Number(amount);
  return Number(amount) / Number(rateLrdPerUsd || 1);
}

// The inverse: converts a USD amount into `currency` at the given rate.
function fromUSD(usdAmount, currency, rateLrdPerUsd) {
  if (currency === 'USD') return usdAmount;
  return usdAmount * Number(rateLrdPerUsd || 1);
}

// Converts an amount from one currency/rate pair into another currency/rate pair,
// via USD as the common intermediate. If both sides are the same currency, this is
// just the identity - no rate is needed or used in that case.
function convert(amount, fromCurrency, fromRate, toCurrency, toRate) {
  if (fromCurrency === toCurrency) return Number(amount);
  return fromUSD(toUSD(amount, fromCurrency, fromRate), toCurrency, toRate);
}

module.exports = { toUSD, fromUSD, convert };
