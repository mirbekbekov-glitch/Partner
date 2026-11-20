import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Кабинет закрыт целиком: индексировать его нечему.
  async headers() {
    return [
      { source: '/cabinet/:path*', headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] },
    ];
  },
};

export default nextConfig;
