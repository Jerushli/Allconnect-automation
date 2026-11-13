'use strict';

function sanitizeDiagnosticUrl(value) {
  try {
    const url = new URL(value);
    const safeRoutes = new Set([
      '/', '/login', '/allconnect-frame/order-summary/',
      '/allconnect-frame/recommendations/', '/allconnect-frame/internet-offers/',
      '/allconnect-frame/checkout/', '/allconnect-frame/installation-payment/'
    ]);
    const path = url.pathname === '/' ? '/' : `${url.pathname.replace(/\/+$/, '')}/`;
    return `${url.origin}${safeRoutes.has(path) ? path : '/[redacted-path]'}`;
  } catch {
    return '[unavailable]';
  }
}

function redactDiagnosticText(value) {
  return String(value || '')
    .replace(/\b\d{3}-?\d{2}-?\d{4}\b/g, '[REDACTED]')
    .replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, '[REDACTED]')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '[REDACTED]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED]')
    .replace(/\b(?:\+?\d[\d .()/-]{7,}\d)\b/g, '[REDACTED]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(password|token|secret|authorization)\s*[:=]\s*\S+/gi, '$1=[REDACTED]');
}

function safeDiagnosticLabel(value) {
  const label = String(value || '').trim();
  const allowed = new Set([
    'Order Summary', 'Credit Check', 'Order Qualification Status',
    'Installation and Payment', 'Installation & Payment',
    'ProviderXX Checkout', 'Recommendations', 'Internet', 'Product Details',
    'Account Holder Qualification', 'Product Customization',
    'Installation', 'Authorization', 'Payment Information', 'Simulator', 'Portal'
  ]);
  return allowed.has(label) ? label : label ? '[redacted]' : '';
}

async function captureRedactedScreenshot() {
  // Portal pages can render PII outside form controls. Do not capture them;
  // heuristic masking cannot guarantee that unstructured text is safe.
  return false;
}

module.exports = {
  sanitizeDiagnosticUrl,
  redactDiagnosticText,
  safeDiagnosticLabel,
  captureRedactedScreenshot
};
