// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The island's response headers, copied header for header from the site's
// nginx snippet circuits-com/nginx/editor-headers.conf (the file every
// location of the editor server block includes). Keep the two identical: a
// header changed there is changed here. `$cc_page_origin` stays a placeholder;
// serve.mjs puts the page origin in its place (the CSP frame-ancestors and the
// Access-Control-Allow-Origin value).
export const PAGE_ORIGIN_PLACEHOLDER = '$cc_page_origin';

export const ISLAND_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-site',
  'Content-Security-Policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' blob:; worker-src 'self' blob:; connect-src 'self' blob: data:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; frame-ancestors $cc_page_origin; base-uri 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Access-Control-Allow-Origin': '$cc_page_origin',
};

/** The header set with the page origin substituted everywhere the snippet names $cc_page_origin. */
export function islandHeaders(pageOrigin) {
  return Object.fromEntries(Object.entries(ISLAND_HEADERS).map(([k, v]) => [k, v.split(PAGE_ORIGIN_PLACEHOLDER).join(pageOrigin)]));
}
