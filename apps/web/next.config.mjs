// HSTS only once the site is served over TLS (WEB_ORIGIN https://...); on the SSH-tunnel staging it would be ignored
const tls = (process.env.WEB_ORIGIN ?? '').startsWith('https://');

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          ...(tls ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }] : []),
          // Content-Security-Policy (nonce-based) is set per request in middleware.ts
        ],
      },
    ];
  },
};

export default nextConfig;
