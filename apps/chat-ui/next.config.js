/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Enables typed route helpers and stricter route inference in modern Next.js.
    typedRoutes: true
  }
};

export default nextConfig;
