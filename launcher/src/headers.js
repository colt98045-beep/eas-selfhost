// Security headers for every launcher response.
// The launcher pages load only same-origin scripts (public/js/*, /banner.js)
// and fetch only same-origin APIs, so script-src and connect-src are 'self'.
// Inline styles stay allowed (style attributes and banner.js's <style> tag).
// Deliberately NOT set: Cross-Origin-Resource-Policy / COEP, because the US and
// CA dashboards fetch /api/announcements and /api/maintenance cross-origin.
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

export const SECURITY_HEADERS = {
  "content-security-policy": CSP,
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), interest-cohort=()",
  "cross-origin-opener-policy": "same-origin",
};

export function withSecurityHeaders(response) {
  if (!response || response.status === 101) return response;
  let out;
  try {
    out = new Response(response.body, response);
  } catch {
    return response;
  }
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    // Keep a stricter value a handler already chose (e.g. admin's no-referrer).
    if (!out.headers.has(name)) out.headers.set(name, value);
  }
  return out;
}
