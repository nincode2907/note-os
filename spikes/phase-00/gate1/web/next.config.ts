import type { NextConfig } from 'next';

const config: NextConfig = {
  async rewrites() {
    // Native sync handlers (including unknown reserved paths) resolve before legacy fallback.
    return { fallback: [{ source: '/api/:path*', destination: 'http://gate1-api:15001/api/:path*' }] };
  },
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
      { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
    ] }];
  },
};

export default config;
