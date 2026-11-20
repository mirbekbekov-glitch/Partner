/** @type {import('next').NextConfig} */
const nextConfig = {
  // Каталог читается из базы на сервере, поэтому ничего не выносим в клиент.
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
